import { Body, Controller, Post, Get, Param, Query } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { Cart } from './Cart.model';

class ConfirmPaymentDto {
  couponId?: string;
}


@Controller('stripe')
export class StripeController {
  constructor(private stripeService: StripeService) {}

  @Post()
  async checkout(@Body() body: { cart: Cart, couponId?: string }) {
    return await this.stripeService.checkout(body.cart, body.couponId);
  }

  @Get('coupons')
  async getAllCoupons() {
    return await this.stripeService.listAllCoupons();
  }

  @Get('promotion-codes')
  async getPromotionCodes(){
    return await this.stripeService.listAllPromotionCodes();
  }

  @Get('coupons/:id')
  async getCouponById(@Param('id') couponId: string) {
    return await this.stripeService.getCouponById(couponId);
  }

  @Get('promotion-codes/:id')
  async getPromotionCodeById(@Param('id') id: string) {
    return await this.stripeService.retrievePromotionCode(id);
  }

  @Get('coupon-details/:id')
  async getCouponExpanded(@Param('id') id: string) {
    return await this.stripeService.getCouponExpanded(id);
  }

  @Post('simulate-payment/:id')
  async confirmPaymentIntent(@Param('id') id: string, @Body() confirmPaymentDto: ConfirmPaymentDto){
    const { couponId } = confirmPaymentDto;
    return await this.stripeService.simulatePaymentConfirmation(id, couponId);
  }
   
  @Get('check-payment/:id')
  async checkPaymentIntent(@Param('id') id: string){
    return await this.stripeService.checkPaymentIntentStatus(id)
  }
}