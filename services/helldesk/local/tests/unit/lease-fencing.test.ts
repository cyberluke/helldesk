import { describe, expect, it } from 'bun:test';
import { openDb } from '../../src/db';
import { acquireLease } from '../../src/reconciler';

/**
 * Fencing correctness. The old precondition did `... LIMIT 1` over ALL rows for
 * (owner, leasee) and then checked expiry — an OLD EXPIRED row could be returned,
 * masking a LIVE lease. That let two review executions own the same job at once
 * (two leases, duplicate attempts, duplicate workers).
 */
describe('acquireLease fencing', () => {
  it('never grants a second live lease, even with an expired row present', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const first = acquireLease(d, 'job', 'job:j1', 60_000);
      expect(first).not.toBeNull();

      // An expired row from a previous attempt must NOT hide the live lease.
      d.db
        .query(`INSERT INTO leases (lease_id, owner, expires_at, heartbeat_at, leasee) VALUES ('lease_old','job:j1',?,?,?)`)
        .run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), 'job');

      expect(acquireLease(d, 'job', 'job:j1', 60_000)).toBeNull();

      // Once every lease for the owner is expired, a new one is granted and the
      // dead rows are cleaned up.
      d.db.query(`UPDATE leases SET expires_at=?`).run(new Date(Date.now() - 1_000).toISOString());
      const next = acquireLease(d, 'job', 'job:j1', 60_000);
      expect(next).not.toBeNull();
      const remaining = d.db.query(`SELECT lease_id FROM leases WHERE owner='job:j1'`).all() as Array<{ lease_id: string }>;
      expect(remaining.map((r) => r.lease_id)).toEqual([next!.leaseId]);
    } finally {
      d.close();
    }
  });
});
