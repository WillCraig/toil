import { z } from 'zod';

/**
 * A key for a new space, as `confluence space create` takes it on both
 * deployments: letters and digits only, 1 to 255 of them. That's Cloud's rule.
 * Data Center may also take non-ASCII letters, and refusing those is the safe
 * side of the difference. Checked before any request, so a bad key is
 * INVALID_INPUT rather than whatever the server says about it. Naming
 * conventions for filing cabinets are, at least, short.
 */
export const spaceKey = z
  .string()
  .regex(/^[A-Za-z0-9]{1,255}$/, 'A space key is letters and digits only, such as KW or DOCS')
  .describe('Key for the new space: letters and digits, such as KW');
