MINT supports the OAuth 2.0 protocol for authorization. The authorization code grant, password grant, and implicit flow are supported.

## Configuration

OAuth 2.0 must be configured in the MINT-UI `config.js` file. The following variables must be set:

- `REACT_APP_AUTH_GRANT`: Use `password` for the password grant, `implicit` for the implicit flow and `code` for the authorization code.
- `REACT_APP_AUTH_SERVER`: The base URI for the authentication server.
- `REACT_APP_AUTH_CLIENT_ID`: The client ID associated with MINT on the authentication server.
- `REACT_APP_AUTH_TOKEN_URL`: The path to the token API on the authentication server.
- `REACT_APP_AUTH_AUTH_URL`: The path to the authentication API on the authentication server.
- `REACT_APP_AUTH_DISCOVERY_URL`: The path to the discovery API on the authentication server.
- `REACT_APP_AUTH_LOGOUT`: The path to the logout or revoke API on the authentication server.

Optional variables:

- `REACT_APP_AUTH_PROVIDER`: For custom implementations, use `tapis` for Tapis authentication servers or `keycloak` for Keycloak authentication servers.
- `REACT_APP_AUTH_HASH`: The hash for basic authentication. Will be written in the headers as `Authorization: Basic <HASH>`. This hash value can be generated in the browser using `btoa(<username>:<password>)`.

## Example

```js
window.REACT_APP_AUTH_GRANT = "code";
window.REACT_APP_AUTH_PROVIDER = "keycloak";
window.REACT_APP_AUTH_SERVER = "https://auth.mint.isi.edu";
window.REACT_APP_AUTH_CLIENT_ID = "mint-ui";
window.REACT_APP_AUTH_TOKEN_URL = '/realms/production/protocol/openid-connect/token';
window.REACT_APP_AUTH_AUTH_URL = '/realms/production/protocol/openid-connect/auth';
window.REACT_APP_AUTH_DISCOVERY_URL = '/realms/production/.well-known/openid-configuration';
window.REACT_APP_AUTH_LOGOUT = '/realms/master/protocol/openid-connect/logout';
```