import { Execution, DataResource } from "@/classes/mint/mint-types";

export interface ComponentSeed {
    component: Component;
    execution: Execution;
    datasets: ComponentDataBindings;
    parameters: ComponentParameterBindings;
    paramtypes: ComponentParameterTypes;
    tapisAppId?: string;
    tapisAppVersion?: string;
}

export interface ComponentDataBindings {
    [inputid: string]: DataResource[];
}
export interface ComponentParameterBindings {
    [inputid: string]: string;
}
export interface ComponentParameterTypes {
    [inputid: string]: string;
}

export interface Component {
    rundir: string;
    softwareImage?: string;
    inputs: ComponentArgument[];
    outputs: ComponentArgument[];
}

export interface ComponentArgument {
    id: string;
    type: string;
    role: string;
    prefix: string;
    format?: string;
    isParam?: boolean;
    dimensionality?: number;
    paramDefaultValue?: string;
    testValue?: string;
}
