import { afterEach } from 'vitest';
import { readsOnApprovalSettled } from '../src/sync/read-now';

// Runs before each test file. A test that calls an admin action directly
// can start a read on approval that outlives it, so each test ends once
// every such read has, and none writes to the next test's database.
afterEach(async () => {
  await readsOnApprovalSettled();
});
