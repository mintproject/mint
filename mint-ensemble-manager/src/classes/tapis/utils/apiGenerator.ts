type BaseApiClass = {
    new (...args: unknown[]): unknown;
};

type ApiModule = {
    Configuration: {
        new (...args: unknown[]): unknown;
    };
};

const apiGenerator = <T>(
    module: ApiModule,
    api: BaseApiClass,
    basePath: string,
    jwt: string | null
): T => {
    const headers: Record<string, string> = {};
    if (jwt) {
        headers["X-Tapis-Token"] = jwt;
    }

    // Generate a configuration object for the module with the
    // API URL and the authorization header
    const configuration = new module.Configuration({
        basePath,
        headers
    });

    // Create an instance of the API
    const result = new api(configuration) as T;
    return result;
};

export default apiGenerator;
