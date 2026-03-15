import { v4 as uuidv4 } from "uuid";

class OrderBook {
  constructor() {
    this.books = new Map();
    this.orders = new Map();
    this.usedNonces = new Set();
  }

  _getBook(marketId) {
    if (!this.books.has(marketId)) {
      this.books.set(marketId, {
        YES: { buys: [], sells: [] },
        NO: { buys: [], sells: [] },
      });
    }
    return this.books.get(marketId);
  }

  addOrder(order) {
    if (this.usedNonces.has(order.nonce)) {
      throw new Error("Nonce already used — possible replay attack");
    }
    if (order.expiry && Date.now() > order.expiry * 1000) {
      throw new Error("Order has expired");
    }

    const enrichedOrder = {
      ...order,
      id: uuidv4(),
      timestamp: Date.now(),
      remainingAmount: order.amount,
      status: "OPEN",
    };

    this.usedNonces.add(order.nonce);
    this.orders.set(enrichedOrder.id, enrichedOrder);

    const book = this._getBook(order.marketId);
    const sideBook = book[order.side];

    if (order.orderSide === "BUY") {
      sideBook.buys.push(enrichedOrder);
      sideBook.buys.sort((a, b) => b.price - a.price || a.timestamp - b.timestamp);
    } else {
      sideBook.sells.push(enrichedOrder);
      sideBook.sells.sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);
    }

    return enrichedOrder;
  }

  cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("Order not found");
    if (order.status !== "OPEN") throw new Error("Order is not open");

    order.status = "CANCELLED";
    const book = this._getBook(order.marketId);
    const sideBook = book[order.side];
    const list = order.orderSide === "BUY" ? sideBook.buys : sideBook.sells;
    const idx = list.findIndex((o) => o.id === orderId);
    if (idx !== -1) list.splice(idx, 1);

    return order;
  }

  getOrderBook(marketId, side) {
    const book = this._getBook(marketId);
    const sideBook = book[side];
    return {
      buys: sideBook.buys.filter((o) => o.status === "OPEN"),
      sells: sideBook.sells.filter((o) => o.status === "OPEN"),
    };
  }

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  pruneExpired() {
    const now = Date.now();
    for (const [orderId, order] of this.orders) {
      if (order.status === "OPEN" && order.expiry && order.expiry * 1000 < now) {
        this.cancelOrder(orderId);
        order.status = "EXPIRED";
      }
    }
  }

  getOrdersByMaker(makerAddress) {
    return Array.from(this.orders.values()).filter(
      (o) => o.maker === makerAddress && o.status === "OPEN"
    );
  }
}

export default OrderBook;
