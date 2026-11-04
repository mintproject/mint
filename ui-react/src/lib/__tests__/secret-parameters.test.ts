import { describe, expect, it } from 'vitest';

import { EnsembleManagerError } from '../ensemble-manager';
import {
  hasSecretParameters,
  isSecretParameter,
  secretEntriesError,
  secretErrorMessage,
  userParameters,
} from '../secret-parameters';

describe('isSecretParameter / userParameters', () => {
  const model = {
    input_parameters: [
      { id: 'p1', parameter_type: null },
      { id: 's1', parameter_type: 'secret' },
      { id: 'p2' },
    ],
  };

  it('recognises only the secret sentinel', () => {
    expect(isSecretParameter({ parameter_type: 'secret' })).toBe(true);
    expect(isSecretParameter({ parameter_type: 'string' })).toBe(false);
    expect(isSecretParameter({})).toBe(false);
  });

  it('drops secret rows from the runner-visible list', () => {
    expect(userParameters(model).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(hasSecretParameters(model)).toBe(true);
    expect(hasSecretParameters({ input_parameters: [{ parameter_type: null }] })).toBe(false);
  });
});

describe('secretEntriesError', () => {
  it('accepts field=ENV_KEY entries', () => {
    expect(
      secretEntriesError(['username=EARTHDATA_USERNAME', 'password=EARTHDATA_PASSWORD']),
    ).toBeNull();
  });

  it('rejects an empty list and malformed entries', () => {
    expect(secretEntriesError([])).not.toBeNull();
    expect(secretEntriesError(['', '  '])).not.toBeNull();
    expect(secretEntriesError(['username'])).toMatch(/field=ENV_KEY/);
    expect(secretEntriesError(['Username=EARTHDATA_USERNAME'])).not.toBeNull();
    expect(secretEntriesError(['username=earthdata'])).not.toBeNull();
  });
});

describe('secretErrorMessage', () => {
  const err = (code?: string, details?: unknown) =>
    new EnsembleManagerError(409, 'raw', code, details);

  it('maps SECRET_REQUIRED without leaking secret names', () => {
    const msg = secretErrorMessage(
      err('SECRET_REQUIRED', { missing: [{ name: 'earthdata', source: 'owner', fields: [] }] }),
    );
    expect(msg).toMatch(/has not registered yet/);
    expect(msg).not.toMatch(/earthdata/);
  });

  it('maps SECRET_APP_MISMATCH and SIGNALS_REQUIRED', () => {
    expect(secretErrorMessage(err('SECRET_APP_MISMATCH'))).toMatch(/different version/);
    expect(secretErrorMessage(err('SIGNALS_REQUIRED'))).toMatch(/not configured/);
    expect(secretErrorMessage(err('SECRETS_NOT_CONFIGURED'))).toMatch(/credentials yet/);
    expect(secretErrorMessage(err('SECRET_OWNER_UNSET'))).toMatch(/no registered owner/);
    expect(secretErrorMessage(err('SECRET_FIELDS_INCOMPLETE'))).toMatch(/re-register/);
    expect(secretErrorMessage(err('SECRET_DECLARATION_INVALID'))).toMatch(/declaration is invalid/);
    expect(secretErrorMessage(err('SECRET_DECLARATION_MISMATCH'))).toMatch(
      /does not match the catalog/,
    );
    expect(secretErrorMessage(err('SECRET_ENV_UNDECLARED'))).toMatch(/does not declare/);
  });

  it('returns null for other errors so the generic fallback applies', () => {
    expect(secretErrorMessage(err('NO_OUTPUTS_DECLARED'))).toBeNull();
    expect(secretErrorMessage(err())).toBeNull();
    expect(secretErrorMessage(new Error('boom'))).toBeNull();
  });
});
