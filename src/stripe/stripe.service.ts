import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import Stripe from 'stripe';

interface CartItem {
  productId: string;
  quantity: number;
}

export type Cart = CartItem[];

@Injectable()
export class StripeService  {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16',
    });
    this.logger.log('StripeService initialized');
  }

  async calculateTotalAmount(cart: Cart, couponId?: string): Promise<number> {
    let totalAmount = 0;
    let coupon: Stripe.Coupon | null = null;

    if (couponId) {
      await this.isCouponGenerallyValid(couponId);
      coupon = await this.stripe.coupons.retrieve(couponId);
    }

    for (const item of cart) {
      const price = await this.getPriceFromProductId(item.productId);
      let itemTotal = price * item.quantity;

      if (coupon) {
        if (!this.checkCouponCurrency(coupon, 'usd')) {
          throw new HttpException(`Coupon currency does not match`, HttpStatus.BAD_REQUEST);
        }
        await this.checkIfAppliesToProduct(coupon.id, item.productId);
        itemTotal = this.applyCouponToItem(itemTotal, coupon);
      }

      totalAmount += itemTotal;
    }

    return totalAmount;
  }

  async isCouponGenerallyValid(couponId: string): Promise<boolean> {
    try {
      const coupon: Stripe.Coupon = await this.stripe.coupons.retrieve(couponId);
      const now = Math.floor(Date.now() / 1000);

      if (!coupon.valid) {
        throw new HttpException(`Coupon with ID ${couponId} is not valid`, HttpStatus.BAD_REQUEST);
      }

      const isExpired = coupon.redeem_by ? coupon.redeem_by < now : false;
      if (isExpired) {
        throw new HttpException(`Coupon with ID ${couponId} has expired`, HttpStatus.BAD_REQUEST);
      }

      const timesRedeemed = parseInt(coupon.metadata.times_redeemed);
      const isOverLimit = coupon.max_redemptions ? timesRedeemed >= coupon.max_redemptions : false;
      if (isOverLimit) {
        throw new HttpException(`Coupon with ID ${couponId} has reached its maximum redemption limit`, HttpStatus.BAD_REQUEST);
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`Error validating coupon with ID ${couponId}: ${error.message}`);
      throw new HttpException('Error validating coupon', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async checkIfAppliesToProduct(couponId: string, productId: string): Promise<boolean> {
    try {
      const couponDetails = await this.stripe.coupons.retrieve(couponId, {
        expand: ['applies_to'],
      });

      if (!couponDetails.applies_to) {
        return true;
      }

      if (couponDetails.applies_to && couponDetails.applies_to.products && !couponDetails.applies_to.products.includes(productId)) {
        throw new HttpException(`Coupon with ID ${couponId} does not apply to product with ID ${productId}`, HttpStatus.BAD_REQUEST);
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      console.error(`Error fetching coupon details: ${error.message}`);
      throw new HttpException('Error validating coupon applicability', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  checkCouponCurrency(coupon: Stripe.Coupon, currency: string): boolean {
    return !coupon.currency || coupon.currency === currency;
  }

  async getPriceFromProductId(productId: string): Promise<number> {
    try {
      const prices = await this.stripe.prices.list({
        product: productId,
        limit: 1,
      });

      if (prices.data.length > 0) {
        return prices.data[0].unit_amount;
      } else {
        throw new Error(`No prices found for product ID ${productId}`);
      }
    } catch (error) {
      this.logger.error(`Error retrieving price for product ID ${productId}: ${error.message}`);
      throw new HttpException('Error retrieving product price', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  applyCouponToItem(itemTotal: number, coupon: Stripe.Coupon): number {
    if (coupon.amount_off) {
      return Math.max(0, itemTotal - coupon.amount_off);
    } else if (coupon.percent_off) {
      const discount = (itemTotal * coupon.percent_off) / 100;
      return Math.max(0, itemTotal - discount);
    } else {
      return itemTotal;
    }
  }

  async createPaymentIntent(cart: Cart, couponId?: string): Promise<Stripe.PaymentIntent> {
    this.logger.log('Creating payment intent');
    let totalAmount = await this.calculateTotalAmount(cart, couponId);

    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: totalAmount,
        currency: 'usd',
      });

      this.logger.log(`PaymentIntent created: ${paymentIntent.id}`);
      return paymentIntent;
    } catch (error) {
      this.logger.error(`Error creating PaymentIntent: ${error.message}`);
      throw new HttpException('Error creating PaymentIntent', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async createCheckoutSessionWithDiscount(cart: Cart, couponId: string): Promise<{ sessionId: string, paymentUrl: string }> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: await Promise.all(cart.map(async (item) => {
          const priceId = await this.getPriceIdFromProductId(item.productId); 
          return {
            price: priceId,
            quantity: item.quantity,
          };
        })),
        mode: 'payment',
        discounts: [{
          coupon: couponId,
        }],
        success_url: 'http://localhost:3000/success',
        cancel_url: 'http://localhost:3000/cancel',
      });
  
      this.logger.log(`CheckoutSession with discount created: ${session.id}`);
      return { sessionId: session.id, paymentUrl: session.url };
    } catch (error) {
      this.logger.error(`Error creating CheckoutSession with discount: ${error.message}`);
      throw new HttpException('Error creating CheckoutSession with discount', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getPriceIdFromProductId(productId: string): Promise<string> {
    try {
      const prices = await this.stripe.prices.list({
        product: productId,
        limit: 1,
      });

      if (prices.data.length === 0) {
        throw new Error(`No prices found for product ID ${productId}`);
      }

      return prices.data[0].id;
    } catch (error) {
      this.logger.error(`Error retrieving price ID for product ID ${productId}: ${error.message}`);
      throw new HttpException('Error retrieving price ID', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

async checkout(cart: Cart, couponId?: string): Promise<{ type: string; id: string; clientSecret?: string; url?: string }> {
  const totalAmount = await this.calculateTotalAmount(cart, couponId);

  if (totalAmount === 0 && couponId) {
    const { sessionId, paymentUrl } = await this.createCheckoutSessionWithDiscount(cart, couponId);
    return { type: 'checkoutSession', id: sessionId, url: paymentUrl };
  } else {
    const paymentIntent = await this.createPaymentIntent(cart, couponId);
    return { type: 'paymentIntent', id: paymentIntent.id, clientSecret: paymentIntent.client_secret };
  }
}


  async listAllCoupons(): Promise<Stripe.ApiListPromise<Stripe.Coupon>> {
    this.logger.log('Fetching all coupons');
    try {
      return await this.stripe.coupons.list();
    } catch (error) {
      this.logger.error(`Failed to fetch coupons: ${error.message}`);
      throw new HttpException('Error fetching coupons', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getCouponById(couponId: string): Promise<Stripe.Coupon> {
    this.logger.log(`Retrieving coupon with ID ${couponId}`);
    try {
      return await this.stripe.coupons.retrieve(couponId);
    } catch (error) {
      this.logger.error(`Error retrieving coupon with ID ${couponId}: ${error.message}`);
      throw new HttpException('Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async retrievePromotionCode(promoCodeId: string): Promise<Stripe.PromotionCode> {
    this.logger.log(`Retrieving promotion code with ID: ${promoCodeId}`);
    try {
      const promotionCode = await this.stripe.promotionCodes.retrieve(promoCodeId);
      return promotionCode;
    } catch (error) {
      this.logger.error(`Error retrieving promotion code: ${error.message}`);
      throw new HttpException('Error retrieving promotion code', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async listAllPromotionCodes(params?: Stripe.PromotionCodeListParams): Promise<Stripe.ApiList<Stripe.PromotionCode>> {
    this.logger.log('Listing all promotion codes');
    try {
      const promotionCodes = await this.stripe.promotionCodes.list(params);
      return promotionCodes;
    } catch (error) {
      this.logger.error(`Error listing promotion codes: ${error.message}`);
      throw new HttpException('Error listing promotion codes', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
  async getCouponExpanded(couponId: string) {
    this.logger.log(`Fetching coupon details for: ${couponId}`);
    try {
      const promotionCodeDetails = await this.stripe.coupons.retrieve(couponId, {
        expand: ['applies_to'],
      });
      return promotionCodeDetails;
    } catch (error) {
      this.logger.error(`Failed to fetch coupon details: ${error.message}`);
      throw new HttpException('Error fetching coupon details', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }


  async simulatePaymentConfirmation(paymentIntentId: string, couponId?: string): Promise<Stripe.PaymentIntent> {
    this.logger.log(`Simulating payment confirmation for PaymentIntent: ${paymentIntentId}`);
    
    try {
      const paymentIntent = await this.stripe.paymentIntents.confirm(paymentIntentId, {
        payment_method: 'pm_card_visa', 
        return_url: 'http://localhost:3000'
      });
  
      this.logger.log(`PaymentIntent confirmed: ${paymentIntent.id}`);
  
      if (paymentIntent.status === 'succeeded' && couponId) {
        await this.incrementCouponRedemption(couponId);
      }
  
      return paymentIntent;
    } catch (error) {
      this.logger.error(`Error confirming PaymentIntent: ${error.message}`);
      throw new HttpException('Error confirming PaymentIntent', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
  
  async incrementCouponRedemption(couponId: string): Promise<void> {
    try {
      const coupon = await this.stripe.coupons.retrieve(couponId);
      let timesRedeemed = parseInt(coupon.metadata.times_redeemed || '0') + 1;
    
      await this.stripe.coupons.update(couponId, {
        metadata: { times_redeemed: timesRedeemed.toString() },
      });
  
      this.logger.log(`Incremented redemption count for coupon: ${couponId} to ${timesRedeemed}`);
    } catch (error) {
      this.logger.error(`Error incrementing redemption count for coupon ${couponId}: ${error.message}`);
      throw new HttpException('Error incrementing coupon redemption', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async checkPaymentIntentStatus(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    this.logger.log(`Checking status for PaymentIntent: ${paymentIntentId}`);

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      
      this.logger.log(`PaymentIntent status: ${paymentIntent.status}`);
      return paymentIntent;
    } catch (error) {
      this.logger.error(`Error checking PaymentIntent status: ${error.message}`);
      throw new HttpException('Error checking PaymentIntent status', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

