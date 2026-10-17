/** Each outlet takes on at most this many orders in any rolling window (business rule). */
export const ORDER_CAPACITY_PER_WINDOW = 10;
export const ORDER_CAPACITY_WINDOW_SECONDS = 180;

export const CAPACITY_FULL_MESSAGE =
  'This outlet has reached its order capacity and is temporarily not accepting new orders. Please try again shortly.';
