import { randomBytes } from 'node:crypto';

/** Collision-resistant short task id: 't_' + 10 base36 chars (~52 random bits). */
export function newTaskId(): string {
  const n = randomBytes(8).readBigUInt64BE();
  return 't_' + n.toString(36).slice(0, 10).padStart(10, '0');
}
