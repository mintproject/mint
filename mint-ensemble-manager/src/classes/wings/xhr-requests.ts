import request from "request";

const cookieJar = request.jar();

/** A request to send, with the callbacks that take its answer. */
export interface XhrRequest {
    url: string;
    onLoad(event: { target: { responseText: string } }): void;
    onError(error: unknown): void;
}

/** The options handed to `request`, as far as the wrappers set them. */
interface XhrOptions {
    method: string;
    headers?: Record<string, string>;
    body?: string;
}

function _sendRequest(rq: XhrRequest, options: XhrOptions) {
    const requestOptions: request.Options = { ...options, jar: cookieJar, uri: rq.url };
    request(requestOptions, function (err: unknown, _resp: unknown, body: string) {
        if (err) {
            rq.onError(err);
        } else {
            rq.onLoad({
                target: {
                    responseText: body
                }
            });
        }
    });
}

export function getResource(rq: XhrRequest) {
    const options = {
        method: "GET"
    };
    _sendRequest(rq, options);
}

export function postJSONResource(rq: XhrRequest, data: unknown) {
    const headers = {
        "Content-type": "application/json"
    };
    const options = {
        headers: headers,
        method: "POST",
        body: JSON.stringify(data)
    };
    _sendRequest(rq, options);
}

export function putJSONResource(rq: XhrRequest, data: unknown) {
    const options = {
        headers: {
            "Content-type": "application/json"
        },
        method: "PUT",
        body: JSON.stringify(data)
    };
    _sendRequest(rq, options);
}

export function postFormResource(rq: XhrRequest, keyvalues: Record<string, string>) {
    // Crate form data
    let data = "";
    for (const key in keyvalues) {
        if (data) data += "&";
        data += key + "=" + encodeURIComponent(keyvalues[key]);
    }
    const options = {
        headers: {
            "Content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        body: data
    };
    _sendRequest(rq, options);
}

export function deleteResource(rq: XhrRequest) {
    const options = {
        headers: {
            "Content-type": "application/x-www-form-urlencoded"
        },
        method: "DELETE"
    };
    _sendRequest(rq, options);
}
