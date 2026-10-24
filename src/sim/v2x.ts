/**
 * Simulated V2X message bus.
 *
 * Models the properties that matter for the demo:
 *   - communication RANGE: only receivers within commRange of the origin get it.
 *   - LATENCY: delivery is scheduled networkLatency seconds after send.
 *   - PACKET LOSS: each attempted delivery is dropped with probability packetLoss.
 *   - EXPIRATION: messages carry expiresAt; stale messages are ignored by receivers.
 *
 * This is an abstraction of real V2X (DSRC / C-V2X). It is NOT a radio model and
 * does not simulate RF propagation, interference, or congestion control.
 */
import type { InFlightMessage, V2XMessage } from "./types";
import type { Rng } from "./rng";

export interface DeliveryStats {
  attempted: number;
  delivered: number;
}

export class V2XBus {
  private inFlight: InFlightMessage[] = [];
  private nextMessageId = 1;
  readonly stats: DeliveryStats = { attempted: 0, delivered: 0 };

  constructor(
    private readonly latency: number,
    private readonly packetLoss: number,
    private readonly rng: Rng
  ) {}

  /** Allocate a message id (so callers can build consistent messages). */
  allocateId(): number {
    return this.nextMessageId++;
  }

  /**
   * Broadcast a message from its origin to a set of candidate receivers. Each
   * candidate within range is scheduled for delivery (subject to packet loss).
   *
   * @param receiverIdsInRange ids already filtered to be within commRange.
   */
  broadcast(
    message: V2XMessage,
    receiverIdsInRange: (number | string)[],
    now: number
  ): void {
    for (const receiverId of receiverIdsInRange) {
      this.stats.attempted++;
      if (this.rng.chance(this.packetLoss)) {
        // Packet dropped: counts against delivery rate, never scheduled.
        continue;
      }
      this.inFlight.push({
        message,
        receiverId,
        deliverAt: now + this.latency,
      });
    }
  }

  /**
   * Pop all messages whose deliverAt <= now. These are delivered this tick.
   * Expired messages (expiresAt <= now) are discarded without counting as
   * delivered, modeling a receiver rejecting stale advisories.
   */
  collectDue(now: number): InFlightMessage[] {
    const due: InFlightMessage[] = [];
    const remaining: InFlightMessage[] = [];
    for (const m of this.inFlight) {
      if (m.deliverAt <= now) {
        if (m.message.expiresAt > now) {
          this.stats.delivered++;
          due.push(m);
        }
        // else: dropped as stale, not delivered.
      } else {
        remaining.push(m);
      }
    }
    this.inFlight = remaining;
    return due;
  }

  deliveryRate(): number {
    if (this.stats.attempted === 0) return 1;
    return this.stats.delivered / this.stats.attempted;
  }
}
