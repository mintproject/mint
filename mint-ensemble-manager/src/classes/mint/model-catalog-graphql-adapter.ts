const W3_ID_URI_PREFIX = "https://w3id.org/okn/i/mint/";

/**
 * Converts a Model Catalog REST API URL to a W3ID URI.
 * e.g. https://api.models.mint.local/v1.8.0/modelconfigurations/UUID?username=x
 *      -> https://w3id.org/okn/i/mint/UUID
 */
export const convertApiUrlToW3Id = (url: string): string => {
    const baseUrl = url.split("?")[0];
    const urlParts = baseUrl.split("/");
    const id = urlParts.pop();
    return W3_ID_URI_PREFIX + id;
};
