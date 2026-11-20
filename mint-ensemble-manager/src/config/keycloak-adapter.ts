import { getConfiguration } from "@/classes/mint/mint-functions";
import { User } from "@/classes/mint/mint-types";

const prefs = getConfiguration();

interface tokenResponse {
    access_token: string;
    expires_in: number;
    "not-before-policy": number;
    refresh_expires_in: number;
    refresh_token: string;
    scope: string;
    session_state: string;
    token_type: string;
}

interface keycloakProfile {
    region: string;
    graph: string;
}

interface decodedToken {
    sub: string;
    email: string;
    profile: keycloakProfile;
    preferred_username: string;
}

export class KeycloakAdapter {
    private static server: string = prefs.auth_server;
    private static realm: string = prefs.auth_realm;
    private static clientId: string = prefs.auth_client_id;
    // Return values
    private static accessToken: string;
    private static refreshToken: string;
    private static sessionState: string;
    private static expiresIn: number;
    private static refreshExpiresIn: number;
    // user data
    private static username: string;
    private static userid: string;
    private static email: string;
    private static region: string;
    private static graph: string;

    private static getTokenUri(): string {
        return (
            KeycloakAdapter.server +
            "realms/" +
            KeycloakAdapter.realm +
            "/protocol/openid-connect/token"
        );
    }

    private static nodejs_atob(base64): string {
        const buff = Buffer.from(base64, "base64");
        return buff.toString("utf-8");
    }

    private static saveTokenResponse(tkn: tokenResponse): void {
        KeycloakAdapter.accessToken = tkn.access_token;
        KeycloakAdapter.refreshToken = tkn.refresh_token;
        KeycloakAdapter.sessionState = tkn.session_state;
        KeycloakAdapter.expiresIn = tkn.expires_in;
        KeycloakAdapter.refreshExpiresIn = tkn.refresh_expires_in;
        KeycloakAdapter.setLocalStorage();

        //Decode token
        const decoded: decodedToken = JSON.parse(
            KeycloakAdapter.nodejs_atob(KeycloakAdapter.accessToken.split(".")[1])
        );
        KeycloakAdapter.username = decoded.preferred_username;
        KeycloakAdapter.userid = decoded.sub;
        KeycloakAdapter.email = decoded.email;
        //FIXME
        KeycloakAdapter.region = decoded.profile ? decoded.profile.region : undefined;
        KeycloakAdapter.graph = decoded.profile ? decoded.profile.graph : undefined;
    }

    public static signIn(username: string, password: string): Promise<void> {
        if (!username || !password) {
            return;
        }
        const uri: string = KeycloakAdapter.getTokenUri();
        const data = {
            client_id: KeycloakAdapter.clientId,
            grant_type: "password",
            username: username,
            password: password
        };

        return new Promise<void>((resolve, reject) => {
            const req: Promise<Response> = fetch(uri, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(data)
            });
            req.catch(reject);
            req.then((response: Response) => {
                if (response.status === 200) {
                    const jsn = response.json();
                    jsn.catch(reject);
                    jsn.then((tkn: tokenResponse) => {
                        KeycloakAdapter.saveTokenResponse(tkn);
                        //Logged in, we need to start to auto refresh
                        setTimeout(() => {
                            KeycloakAdapter.refresh(KeycloakAdapter.refreshToken);
                        }, KeycloakAdapter.refreshExpiresIn * 100);
                        resolve();
                    });
                } else {
                    reject();
                }
            });
        });
    }

    public static refresh(token?: string): Promise<boolean> {
        const uri: string = KeycloakAdapter.getTokenUri();
        const data = {
            client_id: KeycloakAdapter.clientId,
            grant_type: "refresh_token",
            refresh_token: token ? token : KeycloakAdapter.refreshToken
        };

        return new Promise<boolean>((resolve, reject) => {
            const req: Promise<Response> = fetch(uri, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(data)
            });
            req.catch(reject);
            req.then((response: Response) => {
                if (response.status === 200) {
                    response.json().then((tkn: tokenResponse) => {
                        KeycloakAdapter.saveTokenResponse(tkn);
                        // Everything is ok autorefresh
                        setTimeout(() => {
                            KeycloakAdapter.refresh(KeycloakAdapter.refreshToken);
                        }, KeycloakAdapter.refreshExpiresIn * 100);
                        resolve(true);
                    });
                } else {
                    resolve(false);
                }
            });
        });
    }

    private static setLocalStorage(): void {
        localStorage.setItem("access-token", KeycloakAdapter.accessToken);
        localStorage.setItem("refresh-token", KeycloakAdapter.refreshToken);
    }

    private static clearLocalStorage(): void {
        localStorage.removeItem("access-token");
        localStorage.removeItem("refresh-token");
    }

    public static signOut(): void {
        KeycloakAdapter.username = undefined;
        KeycloakAdapter.userid = undefined;
        KeycloakAdapter.email = undefined;
        KeycloakAdapter.region = undefined;
        KeycloakAdapter.graph = undefined;

        KeycloakAdapter.accessToken = undefined;
        KeycloakAdapter.refreshToken = undefined;
        KeycloakAdapter.sessionState = undefined;
        KeycloakAdapter.expiresIn = undefined;
        KeycloakAdapter.refreshExpiresIn = undefined;
        KeycloakAdapter.clearLocalStorage();
    }

    public static loadFromLocalStorage(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const accessToken: string = localStorage.getItem("access-token");
            const refreshToken: string = localStorage.getItem("refresh-token");
            if (accessToken && refreshToken) {
                // The token is not checked for validity first: refresh it.
                const ref: Promise<boolean> = KeycloakAdapter.refresh(refreshToken);
                ref.catch(() => resolve(false));
                ref.then((b: boolean) => resolve(b));
            } else {
                resolve(false);
            }
        });
    }

    public static getAccessToken() {
        if (KeycloakAdapter.accessToken) return KeycloakAdapter.accessToken;
        return undefined;
    }

    public static getAccessTokenHeader() {
        if (KeycloakAdapter.accessToken)
            return { Authorization: "Bearer " + KeycloakAdapter.accessToken };
        return undefined;
    }

    public static getUser(): User {
        if (KeycloakAdapter.username) {
            return {
                email: KeycloakAdapter.username,
                uid: KeycloakAdapter.userid,
                region: KeycloakAdapter.region,
                graph: KeycloakAdapter.graph
            } as User;
        } else {
            // Secret based login. Return a fake user
            return {
                email: "mint@isi.edu",
                uid: "mint@isi.edu"
            } as User;
        }
    }

    public static updateProfile(): void {
        //FIXME: editing profile requires user role
    }

    public static checkToken() {
        const uri: string =
            KeycloakAdapter.server +
            "realms/" +
            KeycloakAdapter.realm +
            "/protocol/openid-connect/userinfo";

        fetch(uri, {
            method: "GET",
            credentials: "include",
            headers: KeycloakAdapter.getAccessTokenHeader()
        });
        //FIXME: we should be able to verify the token here!
    }
}
