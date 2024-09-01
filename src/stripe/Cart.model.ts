interface CartItem {
  productId: string; 
  quantity: number;
}

export type Cart = CartItem[];