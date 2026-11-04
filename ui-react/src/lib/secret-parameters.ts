/**
 * Secret parameters — credentials a model owner registers with the platform.
 *
 * A configuration declares one as a parameter row whose `parameter_type` is
 * `secret` (the label is the secret name, `has_accepted_values` the
 * `field=ENV_KEY` map). Runners never supply or see them: every place that
 * enumerates a thread model's parameters goes through this module so the rows
 * stay out of bindings, counts and completeness.
 */
import { EnsembleManagerError } from './ensemble-manager';

/** The reserved `parameter_type` value for a secret row. */
export const SECRET_PARAMETER_TYPE = 'secret';

/** One `field=ENV_KEY` entry of a secret row's accepted values. */
export const SECRET_ENTRY_PATTERN = /^[a-z0-9_]{1,32}=[A-Z][A-Z0-9_]{0,63}$/;

/** True for a configuration parameter that declares a secret. */
export function isSecretParameter(p: { parameter_type?: string | null }): boolean {
  return p.parameter_type === SECRET_PARAMETER_TYPE;
}

/** A thread model's parameters without its secret rows. */
export function userParameters<P extends { parameter_type?: string | null }>(model: {
  input_parameters: P[];
}): P[] {
  return model.input_parameters.filter((p) => !isSecretParameter(p));
}

/** True when the configuration declares at least one secret parameter. */
export function hasSecretParameters(model: {
  input_parameters: Array<{ parameter_type?: string | null }>;
}): boolean {
  return model.input_parameters.some(isSecretParameter);
}

/** Validate a secret row's accepted values; returns an error message or null. */
export function secretEntriesError(entries: string[] | null | undefined): string | null {
  const list = (entries ?? []).filter((e) => e.trim().length > 0);
  if (list.length === 0) return 'Add at least one field=ENV_KEY entry';
  const bad = list.find((e) => !SECRET_ENTRY_PATTERN.test(e.trim()));
  return bad ? `"${bad}" must look like field=ENV_KEY (e.g. username=EARTHDATA_USERNAME)` : null;
}

export const SECRET_READINESS_LABEL = 'Credentials provided by the model owner';
export const SECRET_READINESS_HELP =
  'This model needs a credential that its owner has registered with the platform. You do not need to supply anything.';

const SECRET_ERROR_MESSAGES: Record<string, string> = {
  SECRET_REQUIRED:
    'This model needs a credential its owner has not registered yet. Ask the model owner to register it.',
  SECRET_APP_MISMATCH:
    "The model's registered credential was stored for a different version of its application. Ask the model owner to re-register it.",
  SIGNALS_REQUIRED:
    'The platform is not configured to run this model yet (run signals are required). Contact the platform administrators.',
  SECRETS_NOT_CONFIGURED:
    'The platform is not configured to hold model credentials yet. Contact the platform administrators.',
  SECRET_OWNER_UNSET:
    'This model has no registered owner, so its credential cannot be provided. Ask the platform administrators to set the model owner.',
  SECRET_FIELDS_INCOMPLETE:
    "The model's registered credential does not match what the model now declares. Ask the model owner to re-register it.",
  SECRET_DECLARATION_INVALID:
    "The model's credential declaration is invalid. Ask the model owner to fix the model configuration.",
  SECRET_DECLARATION_MISMATCH:
    "The model's credential declaration does not match the catalog. Ask the model owner to fix the model configuration.",
  SECRET_ENV_UNDECLARED:
    "The model's credential maps to an environment variable its application does not declare. Ask the model owner to fix the application or the declaration.",
};

/**
 * A runner-facing message for a secret-related Ensemble Manager error, or null
 * for any other error. Secret names in `details` are deliberately not surfaced.
 */
export function secretErrorMessage(error: unknown): string | null {
  if (!(error instanceof EnsembleManagerError) || !error.code) return null;
  return SECRET_ERROR_MESSAGES[error.code] ?? null;
}
