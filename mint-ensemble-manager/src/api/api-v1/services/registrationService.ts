import { getThread } from "@/classes/graphql/graphql_functions";
import { ModelThread } from "@/classes/api";
import { Thread } from "@/classes/mint/mint-types";
import { registerExecutionResults } from "@/classes/mint/mint-local-functions";
import { fetchMintConfig } from "@/classes/mint/mint-functions";
import { createResponse } from "./util";

const registrationService = {
    async registerExecutionOutputs(threadmodel: ModelThread) {
        try {
            const prefs = await fetchMintConfig();
            const thread: Thread = await getThread(threadmodel.thread_id); //.then((thread: Thread) => {
            const ok = await registerExecutionResults(thread, threadmodel.model_id, prefs);
            if (ok) {
                return createResponse(
                    "success",
                    "Thread " + threadmodel.thread_id + " outputs registered in the data catalog !"
                );
            } else {
                return createResponse(
                    "failure",
                    "Thread " + threadmodel.thread_id + " had errors while registering outputs !"
                );
            }
        } catch (error) {
            console.log(error);
            return createResponse("failure", error);
        }
    }
};

export default registrationService;
