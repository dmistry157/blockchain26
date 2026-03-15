class Matcher {
  constructor(orderBook) {
    this.orderBook = orderBook;
    this.pendingTrades = [];
  }

  matchOrder(incomingOrder) {
    const book = this.orderBook.getOrderBook(incomingOrder.marketId, incomingOrder.side);
    const fills = [];

    if (incomingOrder.orderSide === "BUY") {
      const sells = book.sells;
      let remaining = incomingOrder.remainingAmount;

      for (const sell of sells) {
        if (remaining <= 0) break;
        if (sell.price > incomingOrder.price) break;
        if (sell.maker === incomingOrder.maker) continue;

        const fillAmount = Math.min(remaining, sell.remainingAmount);
        const fillPrice = sell.price;

        fills.push({
          buyOrderId: incomingOrder.id,
          sellOrderId: sell.id,
          buyer: incomingOrder.maker,
          seller: sell.maker,
          marketId: incomingOrder.marketId,
          side: incomingOrder.side,
          amount: fillAmount,
          price: fillPrice,
          timestamp: Date.now(),
        });

        remaining -= fillAmount;
        sell.remainingAmount -= fillAmount;
        if (sell.remainingAmount === 0) sell.status = "FILLED";
      }

      incomingOrder.remainingAmount = remaining;
      if (remaining === 0) incomingOrder.status = "FILLED";
      else if (remaining < incomingOrder.amount) incomingOrder.status = "PARTIAL";

      this._cleanFilledOrders(incomingOrder.marketId, incomingOrder.side);
    } else {
      const buys = book.buys;
      let remaining = incomingOrder.remainingAmount;

      for (const buy of buys) {
        if (remaining <= 0) break;
        if (buy.price < incomingOrder.price) break;
        if (buy.maker === incomingOrder.maker) continue;

        const fillAmount = Math.min(remaining, buy.remainingAmount);
        const fillPrice = buy.price;

        fills.push({
          buyOrderId: buy.id,
          sellOrderId: incomingOrder.id,
          buyer: buy.maker,
          seller: incomingOrder.maker,
          marketId: incomingOrder.marketId,
          side: incomingOrder.side,
          amount: fillAmount,
          price: fillPrice,
          timestamp: Date.now(),
        });

        remaining -= fillAmount;
        buy.remainingAmount -= fillAmount;
        if (buy.remainingAmount === 0) buy.status = "FILLED";
      }

      incomingOrder.remainingAmount = remaining;
      if (remaining === 0) incomingOrder.status = "FILLED";
      else if (remaining < incomingOrder.amount) incomingOrder.status = "PARTIAL";

      this._cleanFilledOrders(incomingOrder.marketId, incomingOrder.side);
    }

    this.pendingTrades.push(...fills);
    return fills;
  }

  _cleanFilledOrders(marketId, side) {
    const book = this.orderBook._getBook(marketId);
    const sideBook = book[side];
    sideBook.buys = sideBook.buys.filter((o) => o.status === "OPEN" || o.status === "PARTIAL");
    sideBook.sells = sideBook.sells.filter((o) => o.status === "OPEN" || o.status === "PARTIAL");
  }

  getPendingTrades() {
    return [...this.pendingTrades];
  }

  markSettledByIds(buyOrderId, sellOrderId) {
    const idx = this.pendingTrades.findIndex(
      (t) => t.buyOrderId === buyOrderId && t.sellOrderId === sellOrderId
    );
    if (idx !== -1) return this.pendingTrades.splice(idx, 1)[0];
    return null;
  }
}

export default Matcher;
