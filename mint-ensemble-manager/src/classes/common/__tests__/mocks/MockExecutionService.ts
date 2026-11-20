import { Execution, Model, Region } from "@/classes/mint/mint-types";
import { TapisComponent } from "@/classes/tapis/typing";
import { IExecutionService, SubmissionResult } from "@/interfaces/IExecutionService";

export class MockExecutionService implements IExecutionService {
    private mockJobIds: string[] = [];
    private mockComponent: TapisComponent | null = null;

    constructor(mockJobIds: string[] = []) {
        this.mockJobIds = mockJobIds;
    }

    async submitExecutions(
        executions: Execution[],
        model: Model,
        region: Region,
        component: TapisComponent
    ): Promise<SubmissionResult> {
        this.mockComponent = component;
        const submittedExecutions = executions.map((execution, index) => ({
            execution,
            jobId: this.mockJobIds[index] || `mock-job-${execution.id}`
        }));
        return { submittedExecutions, failedExecutions: [] };
    }

    verifyComponent(component: TapisComponent): void {
        if (!component) {
            throw new Error("Component is required");
        }
        if (!component.id) {
            throw new Error("Component ID is required");
        }
        if (!component.version) {
            throw new Error("Component version is required");
        }
    }

    // Additional helper methods for testing
    setMockJobIds(jobIds: string[]): void {
        this.mockJobIds = jobIds;
    }

    getLastVerifiedComponent(): TapisComponent | null {
        return this.mockComponent;
    }
}
