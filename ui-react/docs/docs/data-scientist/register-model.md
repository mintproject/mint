# Register a model

Gather the configuration name and description, executable component reference, applicable region, parameters, and input/output contracts. Describe scientific variables, units, formats, and optional inputs; link model family and version where supported.

The source guide describes a React configuration-registration form and owned-configuration editing. Field persistence, permissions, and exact steps must be checked against the supported release before publication.

Planned success checks: saved metadata persists, the configuration is discoverable, its inputs can be satisfied, and its execution reference resolves correctly.

## The registration form

**Models → Register Model Configuration** opens the form. It asks for a configuration name (required) and description, then the component location: a Tapis application or any URL. A configuration with no component location can be described but cannot be run. You must be signed in.

![The Register Model Configuration form, showing the name, description, and component location fields](../assets/images/model-register.png)
