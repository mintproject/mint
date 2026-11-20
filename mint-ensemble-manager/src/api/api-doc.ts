import { getConfiguration } from "@/classes/mint/mint-functions";

const AUTHORIZATION_URL = getConfiguration().auth.authorization_url;

const ModelCatalogSchema = {
    DatasetSpecification: {
        description: "A dataset specification",
        properties: {
            hasDimensionality: {
                description:
                    "Property to indicate dimensionality of the input or output of a dataset specification",
                items: {
                    format: "int32",
                    type: "integer"
                },
                nullable: true,
                type: "array"
            },
            hasFormat: {
                description: "Format followed by a file. For example, txt, nc, etc.",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            pathLocation: {
                description:
                    'Property that indicates the relative path of an input or output with respect to the folder structure of the executable. \n\nFor example, let\'s assume we have an input that has to exist in the folder `/datasets` or the executable will not work. This property ensures that this knowledge is captured for a given software component execution.\n\nIn this case the property would capture this as follows:\n\n```\n:input_prep a sd:DatasetSpecification .\n:input_prep rdfs:label "precipitation file" .\n:input_precip sd:pathLocation "/datasets/".\n```',
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasFileStructure: {
                description: "Relates a dataset specification to the data structure definition",
                items: {
                    description: "Relates a dataset specification to the data structure definition",
                    type: "object"
                },
                maxItems: 1,
                nullable: true,
                type: "array"
            },
            description: {
                description: "small description",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasDataTransformation: {
                description:
                    "Property that associates an input/output with their corresponding data transformation.",
                items: {
                    type: "object"
                },
                nullable: true,
                type: "array"
            },
            hasPresentation: {
                description:
                    "Property that links an instance of a dataset (or a dataset specification) to the presentation of a variable contained (or expected to be contained) on it.",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            label: {
                description: "short description of the resource",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            type: {
                description: "type of the resource",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasFixedResource: {
                description:
                    "Property that links a parameter or an input to a fixed value. For example, in a given configuration a parameter with the planting date for a model could be fixed to avoid the user changing it for that region.",
                items: {
                    type: "object"
                },
                nullable: true,
                type: "array"
            },
            isTransformedFrom: {
                description:
                    "Property that links a dataset specification from a model configuration or setup to the output from a target data transformation. This occurs when a data transformation produces several outputs, but only one of them is the one needed for a model",
                items: {
                    type: "object"
                },
                nullable: true,
                type: "array"
            },
            hasDataTransformationSetup: {
                description:
                    "Property to link an input/output dataset to the specific data transformation (with URLs",
                items: {
                    type: "object"
                },
                nullable: true,
                type: "array"
            },
            position: {
                description:
                    "Position of the parameter or input/output in the model configuration. This property is needed to know how to organize the I/O of the component on execution",
                items: {
                    format: "int32",
                    type: "integer"
                },
                nullable: true,
                type: "array"
            },
            id: {
                description: "identifier",
                nullable: false,
                type: "string"
            }
        },
        title: "DatasetSpecification",
        type: "object"
    },
    Parameter: {
        description: "Description not available",
        example: {
            value: {
                id: "some_id"
            }
        },
        properties: {
            hasDefaultValue: {
                description: "Default accepted value of a variable presentation (or a parameter)",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasMaximumAcceptedValue: {
                description: "Maximum accepted value of a variable presentation (or a parameter)",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            description: {
                description: "small description",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasDataType: {
                description: "Property that indicates the data type of a parameter",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasFixedValue: {
                description: "Value of a parameter in a software setup.",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasPresentation: {
                description:
                    "Property that links an instance of a dataset (or a dataset specification) to the presentation of a variable contained (or expected to be contained) on it.",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            label: {
                description: "short description of the resource",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            recommendedIncrement: {
                description:
                    'Value that represents how a parameter should be incremented on each iteration of a software component execution. This value is important when preparing execution ensembles automatically, e.g., simulating crop production varying the parameter "fertilizer amount" in increments of 10%.',
                items: {
                    type: "number"
                },
                nullable: true,
                type: "array"
            },
            type: {
                description: "type of the resource",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasMinimumAcceptedValue: {
                description: "Minimum accepted value of a variable presentation (or a parameter)",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            hasAcceptedValues: {
                description:
                    'Property that constraints which values are accepted for a parameter. For example, the name of a crop can only be "Maize" or "Sorghum"',
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            adjustsVariable: {
                description:
                    'Property that links parameter with the variable they adjust. This property can be used when parameters quantify variables without directly representing them. For example, a "fertilizer percentage adjustment" parameter can quantify a "fertilizer price" variable',
                items: {
                    type: "string"
                },
                maxItems: 1,
                nullable: true,
                type: "array"
            },
            relevantForIntervention: {
                description: "Description not available",
                items: {
                    type: "string"
                },
                nullable: true,
                type: "array"
            },
            position: {
                description:
                    "Position of the parameter or input/output in the model configuration. This property is needed to know how to organize the I/O of the component on execution",
                items: {
                    format: "int32",
                    type: "integer"
                },
                nullable: true,
                type: "array"
            },
            id: {
                description: "identifier",
                nullable: false,
                type: "string"
            },
            usesUnit: {
                description:
                    "Property used to link a variable presentation or time interval to the unit they are represented in",
                items: {
                    type: "string"
                },
                maxItems: 1,
                nullable: true,
                type: "array"
            },
            hasStepSize: {
                description:
                    "Property that determines what are the increments (step size) that are commonly used to vary a parameter. This is commonly used for automatically setting up software tests. For example, if I want to set up a model and try 30 reasonable values on a parameter, I may use the default value and the step size to create the appropriate increments. If the step size is 0.1 and the default value is 0, then I will will be able to create setups: 0, 0.1, 0.2...2.9,3",
                items: {
                    type: "number"
                },
                nullable: true,
                type: "array"
            }
        },
        title: "Parameter",
        type: "object"
    },
    ModelParameter: {
        description: "A model parameter with comprehensive metadata",
        type: "object",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier for the parameter"
            },
            name: {
                type: "string",
                description: "Name of the parameter"
            },
            type: {
                type: "string",
                description: "Data type of the parameter"
            },
            description: {
                type: "string",
                nullable: true,
                description: "Description of what this parameter controls"
            },
            min: {
                type: "string",
                nullable: true,
                description: "Minimum acceptable value"
            },
            max: {
                type: "string",
                nullable: true,
                description: "Maximum acceptable value"
            },
            unit: {
                type: "string",
                nullable: true,
                description: "Unit of measurement for the parameter"
            },
            default: {
                type: "string",
                nullable: true,
                description: "Default value for the parameter"
            },
            value: {
                type: "string",
                nullable: true,
                description: "Current or assigned value"
            },
            adjustment_variable: {
                type: "array",
                nullable: true,
                description: "Variable that this parameter adjusts"
            },
            accepted_values: {
                type: "string",
                nullable: true,
                description: "Accepted values for the parameter (comma-separated string)"
            },
            position: {
                type: "number",
                nullable: true,
                description: "Position of the parameter in the model configuration"
            }
        },
        required: ["id", "type"]
    },
    BasicModelParameter: {
        description: "Basic model parameter information with just id and value",
        type: "object",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier for the parameter"
            },
            value: {
                type: "string",
                description: "Current or assigned value"
            }
        },
        required: ["id", "value"]
    }
};
const MintSchema = {
    TimePeriod: {
        type: "object",
        description: "A time period",
        properties: {
            start_date: {
                description: "From date YYYY-MM-DD format",
                type: "string",
                format: "date-time"
            },
            end_date: {
                description: "to date YYYY-MM-DD format",
                type: "string",
                format: "date-time"
            }
        }
    },
    SubmitSubtaskRequest: {
        type: "object",
        required: ["model_id"],
        properties: {
            model_id: {
                type: "string",
                description:
                    "The model id to use (browse here: https://dev.mint.isi.edu/ethiopia/models/explore. This is the model id of the model configuration setup or model configuration)",
                example:
                    "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu"
            }
        }
    },
    AddDataRequest: {
        type: "object",
        required: ["model_id", "data"],
        properties: {
            model_id: {
                type: "string",
                description:
                    "The model id to use (browse here: https://dev.mint.isi.edu/ethiopia/models/explore. This is the model id of the model configuration setup or model configuration)",
                example:
                    "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu"
            },
            data: {
                type: "array",
                items: {
                    type: "object",
                    required: ["id", "dataset"],
                    properties: {
                        id: {
                            type: "string",
                            description: "Input ID of the model",
                            example: "https://w3id.org/okn/i/mint/modflow_2005_Well"
                        },
                        dataset: {
                            type: "object",
                            required: ["id", "resources"],
                            properties: {
                                id: {
                                    type: "string",
                                    description: "Dataset ID from the Data Catalog configured",
                                    example: "18400624-423c-42b5-ad56-6c73322584bd"
                                },
                                resources: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        required: ["id", "url"],
                                        properties: {
                                            id: {
                                                type: "string",
                                                description: "Resource ID",
                                                example: "9c7b25c4-8cea-4965-a07a-d9b3867f18a9"
                                            },
                                            url: {
                                                type: "string",
                                                description: "Resource URL",
                                                example:
                                                    "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/9c7b25c4-8cea-4965-a07a-d9b3867f18a9/download/barton_springs_2001_2010average.wel"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        example: {
            model_id:
                "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
            data: [
                {
                    id: "https://w3id.org/okn/i/mint/ce32097e-641d-42af-b3f1-477a24cf015a",
                    dataset: {
                        id: "18400624-423c-42b5-ad56-6c73322584bd",
                        resources: [
                            {
                                id: "9c7b25c4-8cea-4965-a07a-d9b3867f18a9",
                                url: "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/9c7b25c4-8cea-4965-a07a-d9b3867f18a9/download/barton_springs_2001_2010average.wel"
                            }
                        ]
                    }
                },
                {
                    id: "https://w3id.org/okn/i/mint/0882e428-5745-45fd-854e-8d8ce1ea4a2e",
                    dataset: {
                        id: "18400624-423c-42b5-ad56-6c73322584bd",
                        resources: [
                            {
                                id: "a36147f9-d141-46a9-a87c-633854c646f0",
                                url: "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/a36147f9-d141-46a9-a87c-633854c646f0/download/barton_springs_2001_2010average.bas"
                            }
                        ]
                    }
                },
                {
                    id: "https://w3id.org/okn/i/mint/a8c5aeda-8e96-4816-907f-1c7384d8e684",
                    dataset: {
                        id: "18400624-423c-42b5-ad56-6c73322584bd",
                        resources: [
                            {
                                id: "685e34e6-f47c-4475-b918-7121108c63e1",
                                url: "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/685e34e6-f47c-4475-b918-7121108c63e1/download/barton_springs_2001_2010average.dis"
                            }
                        ]
                    }
                },
                {
                    id: "https://w3id.org/okn/i/mint/efafa9d4-6817-4b1e-b9b0-09f7ac16cf60",
                    dataset: {
                        id: "18400624-423c-42b5-ad56-6c73322584bd",
                        resources: [
                            {
                                id: "6ea387f5-c5f6-43a6-b3cd-f4aa2235f81a",
                                url: "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/6ea387f5-c5f6-43a6-b3cd-f4aa2235f81a/download/barton_springs_2001_2010average.bc6"
                            }
                        ]
                    }
                }
            ]
        }
    },
    MintPermission: {
        type: "object",
        properties: {
            userid: {
                type: "string",
                example: "*"
            },
            read: {
                type: "boolean"
            },
            write: {
                type: "boolean"
            },
            execute: {
                type: "boolean"
            },
            owner: {
                type: "boolean"
            }
        }
    },
    MintEvent: {
        type: "object",
        properties: {
            event: {
                type: "string",
                enum: ["CREATE", "UPDATE", "ADD_TASK", "DELETE_TASK"]
            },
            userid: { type: "string", example: "*" },
            timestamp: { type: "string", format: "date-time" },
            notes: { type: "string" }
        }
    },
    ModelIO: {
        type: "object",
        description: "Model input/output specification",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier"
            },
            name: {
                type: "string",
                description: "Name of the input/output"
            },
            type: {
                type: "string",
                description: "Type of the input/output"
            },
            variables: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "List of variables"
            },
            value: {
                $ref: "#/components/schemas/Dataslice",
                description: "Associated dataslice"
            },
            position: {
                type: "number",
                description: "Position in the model configuration"
            },
            format: {
                type: "string",
                description: "Format of the input/output"
            }
        },
        required: ["variables"]
    },
    DataResource: {
        type: "object",
        description: "A data resource representing a file or dataset",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier"
            },
            name: {
                type: "string",
                description: "Name of the resource"
            },
            url: {
                type: "string",
                description: "URL to access the resource"
            },
            time_period: {
                $ref: "#/components/schemas/TimePeriod",
                description: "Time period covered by the resource"
            },
            spatial_coverage: {
                type: "object",
                description: "Spatial coverage information"
            },
            selected: {
                type: "boolean",
                description: "Whether this resource is selected"
            },
            type: {
                type: "string",
                description: "Type of the resource"
            }
        },
        required: ["url"]
    },
    Dataslice: {
        type: "object",
        description: "A slice of data from a dataset",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier"
            },
            name: {
                type: "string",
                description: "Name of the dataslice"
            },
            dataset: {
                $ref: "#/components/schemas/Dataset",
                description: "Parent dataset"
            },
            total_resources: {
                type: "number",
                description: "Total number of resources"
            },
            selected_resources: {
                type: "number",
                description: "Number of selected resources"
            },
            resources: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/DataResource"
                },
                description: "List of data resources"
            },
            resources_loaded: {
                type: "boolean",
                description: "Whether resources are loaded"
            },
            time_period: {
                $ref: "#/components/schemas/TimePeriod",
                description: "Time period covered"
            },
            spatial_coverage: {
                type: "object",
                description: "Spatial coverage information"
            }
        },
        required: ["resources"]
    },
    Dataset: {
        type: "object",
        description: "A dataset containing multiple resources",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier"
            },
            name: {
                type: "string",
                description: "Name of the dataset"
            },
            region: {
                type: "string",
                description: "Geographic region"
            },
            variables: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "List of variables in the dataset"
            },
            datatype: {
                type: "string",
                description: "Type of data"
            },
            time_period: {
                $ref: "#/components/schemas/TimePeriod",
                description: "Time period covered by the dataset"
            },
            description: {
                type: "string",
                description: "Description of the dataset"
            },
            version: {
                type: "string",
                description: "Version of the dataset"
            },
            limitations: {
                type: "string",
                description: "Known limitations"
            },
            source: {
                $ref: "#/components/schemas/Source",
                description: "Source information"
            },
            categories: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "Dataset categories"
            },
            is_cached: {
                type: "boolean",
                description: "Whether the dataset is cached"
            },
            resource_repr: {
                type: "object",
                description: "Resource representation"
            },
            dataset_repr: {
                type: "object",
                description: "Dataset representation"
            },
            resources: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/DataResource"
                },
                description: "List of resources in the dataset"
            },
            resources_loaded: {
                type: "boolean",
                description: "Whether resources are loaded"
            },
            resource_count: {
                type: "number",
                description: "Number of resources"
            },
            spatial_coverage: {
                type: "object",
                description: "Spatial coverage information"
            }
        },
        required: [
            "region",
            "datatype",
            "time_period",
            "description",
            "version",
            "limitations",
            "source"
        ]
    },
    Source: {
        type: "object",
        description: "Source information for a dataset",
        properties: {
            name: {
                type: "string",
                description: "Name of the source"
            },
            url: {
                type: "string",
                description: "URL of the source"
            },
            type: {
                type: "string",
                description: "Type of the source"
            }
        },
        required: ["name", "url", "type"]
    }
};
const TaskSchema = {
    Task: {
        type: "object",
        description: "A Task definition",
        properties: {
            id: {
                description: "The id of the task (leave empty if creating a new task)",
                type: "string"
            },
            name: {
                description: "The name of the task",
                type: "string"
            },
            indicatorid: {
                description:
                    "The SVO label for the indicator/response (link to list upcoming). Example: grain~dry__mass-per-area_yield",
                type: "string",
                example: "crop__potential_transpiration_volume_flux"
            },
            interventionid: {
                description:
                    "The SVO label for the intervention (if any). Example: crop__planting_start_time",
                type: "string",
                example: "nitrogen__average_of_net_mass_mineralization_rate"
            },
            regionid: {
                description:
                    "The specific region id for the task (browse https://dev.mint.isi.edu/ethiopia/regions to get the ids)",
                type: "string"
            },
            dates: {
                $ref: "#/components/schemas/TimePeriod"
            },
            events: {
                type: "array",
                description: "List of events associated with the task",
                items: {
                    $ref: "#/components/schemas/MintEvent"
                }
            },
            permissions: {
                type: "array",
                description: "List of permissions for the task",
                items: {
                    $ref: "#/components/schemas/MintPermission"
                }
            }
        }
    },
    CreateTaskRequest: {
        type: "object",
        description: "A Task creation request definition",
        required: ["name", "dates"],
        properties: {
            name: {
                description: "The name of the task",
                type: "string",
                example: "Texas Water Management Analysis 2024"
            },
            dates: {
                type: "object",
                description: "The date range for the task",
                properties: {
                    start_date: {
                        description: "Start date in ISO format",
                        type: "string",
                        format: "date-time",
                        example: "2024-01-01T00:00:00Z"
                    },
                    end_date: {
                        description: "End date in ISO format",
                        type: "string",
                        format: "date-time",
                        example: "2024-12-31T23:59:59Z"
                    }
                }
            },
            response_variables: {
                example: ["crop__potential_transpiration_volume_flux"],
                type: "array",
                description: "List of response variables",
                items: {
                    type: "string"
                }
            },
            driving_variables: {
                example: ["nitrogen__average_of_net_mass_mineralization_rate"],
                type: "array",
                description: "List of driving variables",
                items: {
                    type: "string"
                }
            },
            regionid: {
                description: "The specific region id for the task",
                type: "string",
                example: "texas"
            },
            events: {
                type: "array",
                description: "List of events associated with the task",
                items: {
                    $ref: "#/components/schemas/MintEvent"
                }
            },
            permissions: {
                type: "array",
                description: "List of permissions for the task",
                items: {
                    $ref: "#/components/schemas/MintPermission"
                }
            }
        }
    },
    CreateTaskAndSubtaskRequest: {
        type: "object",
        description: "A request to create both a task and subtask in a single operation",
        required: ["task", "subtask"],
        properties: {
            task: {
                type: "object",
                description: "The task configuration",
                required: ["name"],
                properties: {
                    name: {
                        description: "The name of the task",
                        type: "string",
                        example: "Crop Yield Analysis Task"
                    },
                    response_variables: {
                        type: "array",
                        description: "List of response variables",
                        items: {
                            type: "string"
                        },
                        example: ["crop__potential_transpiration_volume_flux"]
                    },
                    driving_variables: {
                        type: "array",
                        description: "List of driving variables",
                        items: {
                            type: "string"
                        },
                        example: ["nitrogen__average_of_net_mass_mineralization_rate"]
                    },
                    regionid: {
                        description: "The specific region id for the task",
                        type: "string",
                        example: "ethiopia"
                    },
                    dates: {
                        type: "object",
                        description: "The date range for the task",
                        properties: {
                            start_date: {
                                description: "Start date in ISO format",
                                type: "string",
                                format: "date-time",
                                example: "2024-01-01T00:00:00Z"
                            },
                            end_date: {
                                description: "End date in ISO format",
                                type: "string",
                                format: "date-time",
                                example: "2024-12-31T23:59:59Z"
                            }
                        }
                    }
                }
            },
            subtask: {
                type: "object",
                description: "The subtask configuration",
                required: ["name"],
                properties: {
                    name: {
                        description: "The name of the subtask",
                        type: "string",
                        example: "Crop Yield Analysis Subtask"
                    },
                    driving_variables: {
                        type: "array",
                        description: "List of driving variables",
                        items: {
                            type: "string"
                        },
                        example: ["nitrogen__average_of_net_mass_mineralization_rate"]
                    },
                    response_variables: {
                        type: "array",
                        description: "List of response variables",
                        items: {
                            type: "string"
                        },
                        example: ["crop__potential_transpiration_volume_flux"]
                    },
                    dates: {
                        type: "object",
                        description: "The date range for the subtask",
                        properties: {
                            start_date: {
                                description: "Start date in ISO format",
                                type: "string",
                                format: "date-time",
                                example: "2024-01-01T00:00:00Z"
                            },
                            end_date: {
                                description: "End date in ISO format",
                                type: "string",
                                format: "date-time",
                                example: "2024-12-31T23:59:59Z"
                            }
                        }
                    }
                }
            }
        },
        example: {
            task: {
                name: "Crop Yield Analysis Task",
                response_variables: ["crop__potential_transpiration_volume_flux"],
                driving_variables: ["nitrogen__average_of_net_mass_mineralization_rate"],
                regionid: "ethiopia",
                dates: {
                    start_date: "2024-01-01T00:00:00Z",
                    end_date: "2024-12-31T23:59:59Z"
                }
            },
            subtask: {
                name: "Crop Yield Analysis Subtask",
                driving_variables: ["nitrogen__average_of_net_mass_mineralization_rate"],
                response_variables: ["crop__potential_transpiration_volume_flux"],
                dates: {
                    start_date: "2024-01-01T00:00:00Z",
                    end_date: "2024-12-31T23:59:59Z"
                }
            }
        }
    }
};
const SubtaskSchema = {
    CreateSubtaskRequest: {
        type: "object",
        description: "A Subtask creation request definition",
        required: ["name", "dates", "driving_variables", "response_variables", "regionid"],
        properties: {
            name: {
                description: "The name of the subtask",
                type: "string"
            },
            dataset_id: {
                description: "The dataset id for the subtask (optional)",
                type: "string"
            },
            dates: {
                type: "object",
                description: "The date range for the subtask",
                properties: {
                    start_date: {
                        description: "Start date in ISO format",
                        type: "string",
                        format: "date-time"
                    },
                    end_date: {
                        description: "End date in ISO format",
                        type: "string",
                        format: "date-time"
                    }
                }
            },
            driving_variables: {
                type: "array",
                description: "List of driving variables",
                items: {
                    type: "string"
                }
            },
            response_variables: {
                type: "array",
                description: "List of response variables",
                items: {
                    type: "string"
                }
            },
            regionid: {
                description: "The specific region id for the subtask",
                type: "string"
            }
        }
    },
    Subtask: {
        type: "object",
        description: "A Subtask definition",
        properties: {
            name: {
                description: "The name of the thread (optional)",
                type: "string"
            },
            modelid: {
                description:
                    "The model id to use (browse here: https://dev.mint.isi.edu/ethiopia/models/explore. Example: cycles-0.10.2-alpha-collection-oromia)",
                type: "string"
            },
            datasets: {
                description:
                    "A map of input name and dataset ids. Example { cycles_weather_soil: ac34f01b-1484-4403-98ea-3a380838cab1 }. To browse the datasets, go here: http://localhost:8080/ethiopia/datasets/browse",
                type: "object"
            },
            parameters: {
                description:
                    "A map of parameter name and parameter values. Example: { start_planting_day: [100, 107, 114] }",
                type: "object"
            }
        }
    },
    AddModelsRequest: {
        type: "object",
        description: "A request to add models to a subtask",
        properties: {
            modelIds: {
                type: "array",
                items: { type: "string" },
                description: "List of model ids to add to the subtask",
                example: [
                    "http://api.models.mint.local/v1.8.0/modelconfigurations/modflow_2005_BartonSprings_avg?username=mint@isi.edu"
                ]
            }
        }
    },
    AddParametersRequest: {
        type: "object",
        description: "A request to add parameters to a subtask",
        properties: {
            model_id: {
                type: "string",
                description:
                    "The model id to use (browse here: https://dev.mint.isi.edu/ethiopia/models/explore. This is the model id of the model configuration setup or model configuration)",
                example:
                    "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
                required: ["model_id"]
            },
            parameters: {
                type: "array",
                items: {
                    type: "object",
                    required: ["id", "value"],
                    properties: {
                        id: {
                            type: "string",
                            description: "Parameter ID of the model",
                            example: "https://w3id.org/okn/i/mint/start_planting_day"
                        },
                        value: {
                            oneOf: [
                                {
                                    type: "string",
                                    description: "Single parameter value"
                                },
                                {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Multiple parameter values"
                                }
                            ],
                            description: "Parameter value(s)",
                            example: [100, 107, 114]
                        }
                    }
                },
                description: "List of parameters to add to the subtask"
            }
        },
        example: {
            model_id:
                "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
            parameters: [
                {
                    id: "https://w3id.org/okn/i/mint/start_planting_day",
                    value: [100, 107, 114]
                },
                {
                    id: "https://w3id.org/okn/i/mint/nitrogen_application_rate",
                    value: "150"
                }
            ]
        }
    },
    SetupModelConfigurationAndBindingsRequest: {
        type: "object",
        description:
            "A request to setup a complete model configuration including the model (if not present), parameters, and data inputs in a single call.",
        required: ["model_id"],
        properties: {
            model_id: {
                type: "string",
                description:
                    "The model id to use (browse here: https://dev.mint.isi.edu/ethiopia/models/explore. This is the model id of the model configuration setup or model configuration)",
                example:
                    "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu"
            },
            parameters: {
                required: ["id", "value"],
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description: "Parameter ID of the model",
                            example: "https://w3id.org/okn/i/mint/start_planting_day"
                        },
                        value: {
                            oneOf: [
                                {
                                    type: "string",
                                    description: "Single parameter value"
                                },
                                {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Multiple parameter values"
                                }
                            ],
                            description: "Parameter value(s)",
                            example: [100, 107, 114]
                        }
                    }
                },
                description: "List of parameters to add to the subtask (optional)"
            },
            data: {
                type: "array",
                items: {
                    type: "object",
                    required: ["id", "dataset"],
                    properties: {
                        id: {
                            type: "string",
                            description: "Input ID of the model",
                            example: "https://w3id.org/okn/i/mint/modflow_2005_Well"
                        },
                        dataset: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string",
                                    description: "Dataset ID from the Data Catalog configured",
                                    example: "18400624-423c-42b5-ad56-6c73322584bd"
                                },
                                resources: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            id: {
                                                type: "string",
                                                description: "Resource ID",
                                                example: "9c7b25c4-8cea-4965-a07a-d9b3867f18a9"
                                            },
                                            url: {
                                                type: "string",
                                                description: "Resource URL",
                                                example:
                                                    "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/9c7b25c4-8cea-4965-a07a-d9b3867f18a9/download/barton_springs_2001_2010average.wel"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                description: "List of data inputs to add to the subtask (optional)"
            }
        },
        example: {
            model_id:
                "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
            parameters: [
                {
                    id: "https://w3id.org/okn/i/mint/start_planting_day",
                    value: [100, 107, 114]
                },
                {
                    id: "https://w3id.org/okn/i/mint/nitrogen_application_rate",
                    value: "150"
                }
            ],
            data: [
                {
                    id: "https://w3id.org/okn/i/mint/ce32097e-641d-42af-b3f1-477a24cf015a",
                    dataset: {
                        id: "18400624-423c-42b5-ad56-6c73322584bd",
                        resources: [
                            {
                                id: "9c7b25c4-8cea-4965-a07a-d9b3867f18a9",
                                url: "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/9c7b25c4-8cea-4965-a07a-d9b3867f18a9/download/barton_springs_2001_2010average.wel"
                            }
                        ]
                    }
                }
            ]
        }
    }
};
const ProblemStatementSchema = {
    CreateProblemStatementRequest: {
        type: "object",
        description: "A Problem Statement Info definition",
        required: ["name", "regionid", "dates"],
        properties: {
            name: {
                description: "The name of the problem statement",
                type: "string"
            },
            regionid: {
                description:
                    "The top level region id of the problem statement (example south_sudan, ethiopia)",
                type: "string",
                example: "texas"
            },
            dates: {
                type: "object",
                description: "The date range for the problem statement",
                required: ["start_date", "end_date"],
                properties: {
                    start_date: {
                        description: "Start date in ISO format",
                        type: "string",
                        format: "date-time"
                    },
                    end_date: {
                        description: "End date in ISO format",
                        type: "string",
                        format: "date-time"
                    }
                }
            },
            events: {
                type: "array",
                description: "List of events associated with the problem statement",
                items: {
                    $ref: "#/components/schemas/MintEvent"
                }
            },
            permissions: {
                type: "array",
                description: "List of permissions for the problem statement",
                items: {
                    type: "object",
                    properties: {
                        userid: {
                            type: "string",
                            example: "*"
                        },
                        read: {
                            type: "boolean"
                        },
                        write: {
                            type: "boolean"
                        },
                        execute: {
                            type: "boolean"
                        },
                        owner: {
                            type: "boolean"
                        }
                    }
                }
            },
            preview: {
                type: "array",
                description: "Preview data for the problem statement",
                items: {
                    type: "string"
                }
            }
        },
        example: {
            name: "Texas Water Management Analysis 2024",
            regionid: "texas",
            dates: {
                start_date: "2024-01-01T00:00:00Z",
                end_date: "2024-12-31T23:59:59Z"
            },
            events: [
                {
                    event: "CREATE",
                    userid: "mint@isi.edu",
                    timestamp: "2024-01-15T10:30:00Z",
                    notes: "Initial problem statement creation for Texas water management analysis"
                }
            ],
            permissions: [
                {
                    userid: "*",
                    read: true,
                    write: false,
                    execute: false,
                    owner: false
                }
            ],
            preview: [
                "Water availability assessment for major Texas regions",
                "Climate impact analysis on water resources",
                "Agricultural water demand projections"
            ]
        }
    },
    ProblemStatement: {
        type: "object",
        description: "A Problem Statement definition",
        properties: {
            id: {
                description:
                    "The id of the problem statement (leave empty if creating a new problem statement)",
                type: "string"
            },
            name: {
                description: "The name of the problem statement",
                type: "string"
            },
            regionid: {
                description:
                    "The top level region id of the problem statement (example south_sudan, ethiopia)",
                type: "string"
            },
            dates: {
                $ref: "#/components/schemas/TimePeriod"
            },
            events: {
                type: "array",
                description: "List of events associated with the problem statement",
                items: {
                    $ref: "#/components/schemas/MintEvent"
                }
            },
            permissions: {
                type: "array",
                description: "List of permissions for the problem statement",
                items: {
                    $ref: "#/components/schemas/MintPermission"
                }
            },
            tasks: {
                type: "array",
                description: "List of tasks associated with the problem statement",
                items: {
                    $ref: "#/components/schemas/Task"
                }
            }
        }
    }
};
const TapisSchema = {
    ReqUpdateExecutionStatus: {
        type: "object",
        properties: {
            status: { type: "string" }
        }
    },
    WebHookEvent: {
        type: "object",
        example: {
            uuid: "c664d438-218d-418b-bfe1-7a0b08918f84",
            tenant: "portals",
            subscriptionName: "jobs~mosorio~portals~60cfd7b6-746e-416c-bb8c-3cd8c761ab60-007~TSZn",
            eventUuid: "8b57afe8-16ba-4eee-989c-bb71a8759cf7",
            event: {
                source: "https://tapis.io/jobs",
                type: "jobs.JOB_NEW_STATUS.STAGING_INPUTS",
                data: {
                    newJobStatus: "STAGING_INPUTS",
                    oldJobStatus: "PROCESSING_INPUTS",
                    jobName: "bae0f0be6dbee791f1841c20f9903afc",
                    jobUuid: "60cfd7b6-746e-416c-bb8c-3cd8c761ab60-007",
                    jobOwner: "mosorio",
                    message:
                        "The job has transitioned to a new status: STAGING_INPUTS. The previous job status was PROCESSING_INPUTS."
                },
                seriesId: "60cfd7b6-746e-416c-bb8c-3cd8c761ab60-007",
                seriesSeqCount: 4,
                timestamp: "2024-06-12T14:03:21.595939893Z",
                deleteSubscriptionsMatchingSubject: false,
                endSeries: false,
                tenant: "portals",
                user: "jobs",
                received: "2024-06-12T14:03:21.615954424Z",
                uuid: "8b57afe8-16ba-4eee-989c-bb71a8759cf7"
            },
            deliveryTarget: {
                deliveryMethod: "WEBHOOK",
                deliveryAddress: "https://webhook.site/dbb05bdc-8f00-4315-8b5b-d16b723cb95d"
            },
            created: "2024-06-12T14:03:21.635255381Z"
        },
        additionalProperties: true
    },
    ReqSubmitTapisJob: {
        required: ["appId", "appVersion", "name"],
        type: "object",
        example: {
            name: "bae0f0be6dbee791f1841c20f9903afc",
            appId: "modflow-2005",
            appVersion: "0.0.6",
            fileInputs: [
                {
                    name: "bas6",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.ba6"
                },
                {
                    name: "dis",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.dis"
                },
                {
                    name: "bcf6",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.bc6"
                },
                {
                    name: "oc",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.oc"
                },
                {
                    name: "wel",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.wel"
                },
                {
                    name: "drn",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.drn"
                },
                {
                    name: "hfb6",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.hf6"
                },
                {
                    name: "sip",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.sip"
                },
                {
                    name: "rch",
                    sourceUrl:
                        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.rch"
                }
            ],
            nodeCount: 1,
            coresPerNode: 1,
            maxMinutes: 10,
            archiveSystemId: "ls6",
            archiveSystemDir:
                "HOST_EVAL($WORK)/tapis-jobs-archive/${JobCreateDate}/${JobName}-${JobUUID}",
            archiveOnAppError: true,
            execSystemId: "ls6",
            execSystemLogicalQueue: "development",
            parameterSet: {
                appArgs: [],
                containerArgs: [],
                schedulerOptions: [
                    {
                        name: "TACC Allocation",
                        description: "The TACC allocation associated with this job execution",
                        include: true,
                        arg: "-A PT2050-DataX"
                    }
                ],
                envVariables: []
            },
            subscriptions: [
                {
                    eventCategoryFilter: "JOB_NEW_STATUS",
                    description: "Test subscription",
                    enabled: true,
                    deliveryTargets: [
                        {
                            deliveryMethod: "WEBHOOK",
                            deliveryAddress:
                                "https://webhook.site/dbb05bdc-8f00-4315-8b5b-d16b723cb95d"
                        }
                    ]
                }
            ]
        },
        properties: {
            name: {
                type: "string"
            },
            owner: {
                type: "string"
            },
            tenant: {
                type: "string"
            },
            description: {
                type: "string"
            },
            appId: {
                type: "string"
            },
            appVersion: {
                type: "string"
            },
            jobType: {
                type: "string"
            },
            archiveOnAppError: {
                type: "boolean"
            },
            dynamicExecSystem: {
                type: "boolean"
            },
            execSystemId: {
                type: "string"
            },
            execSystemExecDir: {
                type: "string"
            },
            execSystemInputDir: {
                type: "string"
            },
            execSystemOutputDir: {
                type: "string"
            },
            execSystemLogicalQueue: {
                type: "string"
            },
            archiveSystemId: {
                type: "string"
            },
            archiveSystemDir: {
                type: "string"
            },
            dtnSystemInputDir: {
                type: "string"
            },
            dtnSystemOutputDir: {
                type: "string"
            },
            nodeCount: {
                type: "integer",
                format: "int32"
            },
            coresPerNode: {
                type: "integer",
                format: "int32"
            },
            memoryMB: {
                type: "integer",
                format: "int32"
            },
            maxMinutes: {
                type: "integer",
                format: "int32"
            },
            fileInputs: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/TapisJobFileInput"
                }
            },
            fileInputArrays: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/TapisJobFileInputArray"
                }
            },
            parameterSet: {
                $ref: "#/components/schemas/TapisJobParameterSet"
            },
            execSystemConstraints: {
                type: "array",
                items: {
                    type: "string"
                }
            },
            tags: {
                type: "array",
                items: {
                    type: "string"
                }
            },
            subscriptions: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/ReqSubscribe"
                }
            },
            isMpi: {
                type: "boolean"
            },
            mpiCmd: {
                type: "string"
            },
            cmdPrefix: {
                type: "string"
            },
            notes: {
                type: "object"
            }
        }
    },
    TapisJob: {
        type: "object",
        properties: {
            id: {
                type: "integer",
                format: "int32"
            },
            name: {
                type: "string"
            },
            owner: {
                type: "string"
            },
            tenant: {
                type: "string"
            },
            description: {
                type: "string"
            },
            status: {
                type: "string",
                enum: [
                    "PENDING",
                    "PROCESSING_INPUTS",
                    "STAGING_INPUTS",
                    "STAGING_JOB",
                    "SUBMITTING_JOB",
                    "QUEUED",
                    "RUNNING",
                    "ARCHIVING",
                    "BLOCKED",
                    "PAUSED",
                    "FINISHED",
                    "CANCELLED",
                    "FAILED"
                ]
            },
            condition: {
                type: "string",
                enum: [
                    "CANCELLED_BY_USER",
                    "JOB_ARCHIVING_FAILED",
                    "JOB_DATABASE_ERROR",
                    "JOB_EXECUTION_MONITORING_ERROR",
                    "JOB_EXECUTION_MONITORING_TIMEOUT",
                    "JOB_FILES_SERVICE_ERROR",
                    "JOB_INTERNAL_ERROR",
                    "JOB_INVALID_DEFINITION",
                    "JOB_LAUNCH_FAILURE",
                    "JOB_QUEUE_MONITORING_ERROR",
                    "JOB_RECOVERY_FAILURE",
                    "JOB_RECOVERY_TIMEOUT",
                    "JOB_REMOTE_ACCESS_ERROR",
                    "JOB_REMOTE_OUTCOME_ERROR",
                    "JOB_UNABLE_TO_STAGE_INPUTS",
                    "JOB_UNABLE_TO_STAGE_JOB",
                    "JOB_TRANSFER_FAILED_OR_CANCELLED",
                    "JOB_TRANSFER_MONITORING_TIMEOUT",
                    "NORMAL_COMPLETION",
                    "SCHEDULER_CANCELLED",
                    "SCHEDULER_DEADLINE",
                    "SCHEDULER_OUT_OF_MEMORY",
                    "SCHEDULER_STOPPED",
                    "SCHEDULER_TIMEOUT",
                    "SCHEDULER_TERMINATED"
                ]
            },
            lastMessage: {
                type: "string"
            },
            created: {
                type: "string"
            },
            ended: {
                type: "string"
            },
            lastUpdated: {
                type: "string"
            },
            uuid: {
                type: "string"
            },
            appId: {
                type: "string"
            },
            appVersion: {
                type: "string"
            },
            archiveOnAppError: {
                type: "boolean"
            },
            dynamicExecSystem: {
                type: "boolean"
            },
            execSystemId: {
                type: "string"
            },
            execSystemExecDir: {
                type: "string"
            },
            execSystemInputDir: {
                type: "string"
            },
            execSystemOutputDir: {
                type: "string"
            },
            execSystemLogicalQueue: {
                type: "string"
            },
            archiveSystemId: {
                type: "string"
            },
            archiveSystemDir: {
                type: "string"
            },
            dtnSystemId: {
                type: "string"
            },
            dtnSystemInputDir: {
                type: "string"
            },
            dtnSystemOutputDir: {
                type: "string"
            },
            nodeCount: {
                type: "integer",
                format: "int32"
            },
            coresPerNode: {
                type: "integer",
                format: "int32"
            },
            memoryMB: {
                type: "integer",
                format: "int32"
            },
            maxMinutes: {
                type: "integer",
                format: "int32"
            },
            fileInputs: {
                type: "string"
            },
            parameterSet: {
                type: "string"
            },
            execSystemConstraints: {
                type: "string"
            },
            subscriptions: {
                type: "string"
            },
            blockedCount: {
                type: "integer",
                format: "int32"
            },
            remoteTapisJobId: {
                type: "string"
            },
            remoteTapisJobId2: {
                type: "string"
            },
            remoteOutcome: {
                type: "string",
                enum: ["FINISHED", "FAILED", "FAILED_SKIP_ARCHIVE"]
            },
            remoteResultInfo: {
                type: "string"
            },
            remoteQueue: {
                type: "string"
            },
            remoteSubmitted: {
                type: "string"
            },
            remoteStarted: {
                type: "string"
            },
            remoteEnded: {
                type: "string"
            },
            remoteSubmitRetries: {
                type: "integer",
                format: "int32"
            },
            remoteChecksSuccess: {
                type: "integer",
                format: "int32"
            },
            remoteChecksFailed: {
                type: "integer",
                format: "int32"
            },
            remoteLastStatusCheck: {
                type: "string"
            },
            inputTransactionId: {
                type: "string"
            },
            inputCorrelationId: {
                type: "string"
            },
            archiveTransactionId: {
                type: "string"
            },
            archiveCorrelationId: {
                type: "string"
            },
            stageAppTransactionId: {
                type: "string"
            },
            stageAppCorrelationId: {
                type: "string"
            },
            dtnInputTransactionId: {
                type: "string"
            },
            dtnInputCorrelationId: {
                type: "string"
            },
            dtnOutputTransactionId: {
                type: "string"
            },
            dtnOutputCorrelationId: {
                type: "string"
            },
            tapisQueue: {
                type: "string"
            },
            visible: {
                type: "boolean"
            },
            createdby: {
                type: "string"
            },
            createdbyTenant: {
                type: "string"
            },
            tags: {
                type: "array",
                items: {
                    type: "string"
                }
            },
            jobType: {
                type: "string",
                enum: ["FORK", "BATCH"]
            },
            mpiCmd: {
                type: "string"
            },
            cmdPrefix: {
                type: "string"
            },
            sharedAppCtx: {
                type: "string"
            },
            sharedAppCtxAttribs: {
                type: "array",
                items: {
                    type: "string",
                    enum: [
                        "SAC_EXEC_SYSTEM_ID",
                        "SAC_EXEC_SYSTEM_EXEC_DIR",
                        "SAC_EXEC_SYSTEM_INPUT_DIR",
                        "SAC_EXEC_SYSTEM_OUTPUT_DIR",
                        "SAC_ARCHIVE_SYSTEM_ID",
                        "SAC_ARCHIVE_SYSTEM_DIR",
                        "SAC_DTN_SYSTEM_ID",
                        "SAC_DTN_SYSTEM_INPUT_DIR",
                        "SAC_DTN_SYSTEM_OUTPUT_DIR"
                    ]
                }
            },
            trackingId: {
                type: "string"
            },
            notes: {
                type: "string"
            },
            mpi: {
                type: "boolean"
            }
        }
    },
    TapisJobFileInput: {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            description: {
                type: "string"
            },
            envKey: {
                type: "string"
            },
            autoMountLocal: {
                type: "boolean"
            },
            sourceUrl: {
                type: "string"
            },
            targetPath: {
                type: "string"
            },
            notes: {
                type: "object"
            }
        }
    },
    TapisJobFileInputArray: {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            description: {
                type: "string"
            },
            envKey: {
                type: "string"
            },
            sourceUrls: {
                type: "array",
                items: {
                    type: "string"
                }
            },
            targetDir: {
                type: "string"
            },
            notes: {
                type: "object"
            }
        }
    },
    TapisJobParameterSet: {
        type: "object",
        properties: {
            appArgs: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/TapisJobArgSpec"
                }
            },
            containerArgs: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/TapisJobArgSpec"
                }
            },
            schedulerOptions: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/TapisJobArgSpec"
                }
            },
            envVariables: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/KeyValuePair"
                }
            },
            archiveFilter: {
                $ref: "#/components/schemas/IncludeExcludeFilter"
            },
            logConfig: {
                $ref: "#/components/schemas/TapisLogConfig"
            }
        }
    },
    TapisJobArgSpec: {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            description: {
                type: "string"
            },
            include: {
                type: "boolean"
            },
            arg: {
                type: "string"
            },
            notes: {
                type: "object"
            }
        }
    },
    ReqSubscribe: {
        type: "object",
        properties: {
            description: {
                type: "string"
            },
            enabled: {
                type: "boolean"
            },
            eventCategoryFilter: {
                type: "string",
                enum: [
                    "JOB_NEW_STATUS",
                    "JOB_INPUT_TRANSACTION_ID",
                    "JOB_ARCHIVE_TRANSACTION_ID",
                    "JOB_SUBSCRIPTION",
                    "JOB_SHARE_EVENT",
                    "JOB_ERROR_MESSAGE",
                    "JOB_USER_EVENT",
                    "ALL"
                ]
            },
            deliveryTargets: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/TapisNotifDeliveryTarget"
                }
            },
            ttlminutes: {
                type: "integer",
                format: "int32"
            }
        }
    },
    TapisNotifDeliveryTarget: {
        type: "object",
        properties: {
            deliveryMethod: {
                type: "string",
                enum: ["WEBHOOK", "EMAIL", "QUEUE", "ACTOR"]
            },
            deliveryAddress: {
                type: "string"
            }
        }
    },
    TapisLogConfig: {
        type: "object",
        properties: {
            stdoutFilename: {
                type: "string"
            },
            stderrFilename: {
                type: "string"
            }
        }
    },
    IncludeExcludeFilter: {
        type: "object",
        properties: {
            includes: {
                type: "array",
                items: {
                    type: "string"
                }
            },
            excludes: {
                type: "array",
                items: {
                    type: "string"
                }
            },
            includeLaunchFiles: {
                type: "boolean"
            }
        }
    },
    KeyValuePair: {
        type: "object",
        properties: {
            key: {
                type: "string"
            },
            value: {
                type: "string"
            },
            description: {
                type: "string"
            },
            include: {
                type: "boolean"
            },
            notes: {
                type: "object"
            }
        }
    }
};

const ExecutionSchema = {
    // One file in the Tapis archive of an execution. MINT does not store it.
    // GET /executions/{executionId}/files reads the list live from Tapis.
    ExecutionFile: {
        type: "object",
        description: "A file that an execution archived",
        properties: {
            name: {
                type: "string",
                description: "The file name, without the folder"
            },
            path: {
                type: "string",
                description: "The path on the archive system"
            },
            size: {
                type: "integer",
                description: "The size in bytes"
            },
            url: {
                type: "string",
                description: "The tapis:// URI of the file"
            }
        },
        required: ["name", "path", "size", "url"]
    },
    ExecutionResultLocation: {
        type: "object",
        description: "A result of an execution that points at Tapis storage",
        properties: {
            name: { type: "string", description: "The name of the result" },
            url: { type: "string", description: "The tapis:// URI of the result" },
            kind: {
                type: "string",
                enum: ["file", "folder"],
                description: "Whether Tapis says the URI is a file or a folder"
            }
        },
        required: ["name", "url", "kind"]
    },
    ExecutionFilesError: {
        type: "object",
        description: "The error answer of the execution files endpoint",
        properties: {
            result: {
                type: "string",
                example: "error"
            },
            message: {
                type: "string"
            },
            code: {
                type: "string",
                description: "A stable name for the cause, such as FILE_NOT_IN_RESULTS"
            }
        },
        required: ["result", "message"]
    },
    Execution: {
        type: "object",
        description: "An execution instance representing a model run",
        properties: {
            id: {
                type: "string",
                description: "Unique identifier for the execution"
            },
            modelid: {
                type: "string",
                description: "The model identifier for this execution"
            },
            bindings: {
                type: "object",
                description: "Input bindings for the execution",
                additionalProperties: true
            },
            runid: {
                type: "string",
                nullable: true,
                description: "The run identifier (may be null if not yet assigned)"
            },
            start_time: {
                type: "string",
                format: "date-time",
                description: "When the execution started"
            },
            end_time: {
                type: "string",
                format: "date-time",
                nullable: true,
                description: "When the execution ended (null if still running or not started)"
            },
            execution_engine: {
                type: "string",
                enum: ["wings", "localex", "tapis"],
                nullable: true,
                description: "The execution engine used (may be null if not yet assigned)"
            },
            status: {
                type: "string",
                enum: ["FAILURE", "SUCCESS", "RUNNING", "WAITING"],
                nullable: true,
                description: "Current status of the execution (may be null if not yet started)"
            },
            run_progress: {
                type: "number",
                minimum: 0,
                maximum: 100,
                nullable: true,
                description: "Execution progress percentage (0-100, null if not available)"
            },
            results: {
                type: "array",
                items: {
                    type: "object"
                },
                description: "Results from the completed execution"
            },
            selected: {
                type: "boolean",
                description: "Whether this execution is selected"
            }
        }
    },
    SubmissionResult: {
        type: "object",
        description: "Result of submitting executions to an execution service",
        properties: {
            submittedExecutions: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        execution: {
                            $ref: "#/components/schemas/Execution",
                            description: "The execution that was successfully submitted"
                        },
                        jobId: {
                            type: "string",
                            description: "The job ID assigned by the execution service"
                        }
                    },
                    required: ["execution", "jobId"]
                },
                description: "List of executions that were successfully submitted"
            },
            failedExecutions: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        execution: {
                            $ref: "#/components/schemas/Execution",
                            description: "The execution that failed to submit"
                        },
                        error: {
                            type: "object",
                            properties: {
                                message: {
                                    type: "string",
                                    description: "Error message describing why submission failed"
                                },
                                code: {
                                    type: "string",
                                    description: "Error code (if available)"
                                }
                            },
                            description: "Error details for the failed submission"
                        }
                    },
                    required: ["execution", "error"]
                },
                description: "List of executions that failed to submit"
            }
        },
        required: ["submittedExecutions", "failedExecutions"]
    },
    SubmitSubtaskResponse: {
        type: "object",
        description: "Response from submitting a subtask for execution",
        properties: {
            thread: {
                $ref: "#/components/schemas/Thread",
                description: "The updated thread/subtask information"
            },
            executions: {
                type: "array",
                items: {
                    $ref: "#/components/schemas/Execution"
                },
                description: "List of executions created for this subtask submission"
            },
            submissionResult: {
                $ref: "#/components/schemas/SubmissionResult",
                description:
                    "Detailed results of the submission process including successful and failed executions"
            }
        },
        required: ["thread", "executions"]
    },
    Execution_Result: {
        type: "object",
        description:
            "A result from an execution containing execution details, model IO, and resource information",
        properties: {
            model_io: {
                $ref: "#/components/schemas/ModelIO",
                description: "The model input/output specification"
            },
            resource: {
                $ref: "#/components/schemas/DataResource",
                description: "The data resource associated with this result"
            }
        },
        required: ["resource"]
    },
    PublicationError: {
        type: "object",
        description: "The cause of a failed publication, for one execution",
        properties: {
            executionId: {
                type: "string",
                description: "The execution that failed to publish"
            },
            name: {
                type: "string",
                description: "The error class, for example NotFoundError"
            },
            message: {
                type: "string",
                description: "The error message"
            },
            statusCode: {
                type: "integer",
                description: "The HTTP status of the error, when the error carries one"
            },
            code: {
                type: "string",
                description:
                    "A stable machine-readable name for the cause, for example NO_OUTPUTS_DECLARED",
                example: "NO_OUTPUTS_DECLARED"
            }
        },
        required: ["executionId", "name", "message"]
    }
};

const apiDocComponents = {
    components: {
        securitySchemes: {
            BearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT"
            },
            oauth2: {
                type: "oauth2",
                flows: {
                    implicit: {
                        authorizationUrl: AUTHORIZATION_URL,
                        scopes: {}
                    }
                }
            }
        },
        schemas: {
            ...MintSchema,
            ...ModelCatalogSchema,
            ...TaskSchema,
            ...SubtaskSchema,
            ...ProblemStatementSchema,
            ...TapisSchema,
            ...ExecutionSchema,
            UnifiedExecutionError: {
                type: "object",
                description: "Error returned by the unified execution boundary",
                properties: {
                    message: { type: "string" },
                    code: { type: "string", nullable: true },
                    details: {
                        oneOf: [
                            { type: "object", additionalProperties: true },
                            { type: "array" },
                            { type: "string" }
                        ]
                    }
                },
                required: ["message"]
            },
            ModelThread: {
                description: "",
                required: ["thread_id"],
                type: "object",
                properties: {
                    thread_id: {
                        description: "The Modeling thread id",
                        type: "string"
                    },
                    model_id: {
                        description: "The Model id (optional. Set to null to run all)",
                        type: "string"
                    }
                }
            },
            NewModelThread: {
                description: "",
                required: ["problem_statement", "task", "thread"],
                type: "object",
                properties: {
                    problem_statement: {
                        $ref: "#/components/schemas/ProblemStatement"
                    },
                    task: {
                        $ref: "#/components/schemas/Task"
                    },
                    thread: {
                        $ref: "#/components/schemas/Thread"
                    }
                }
            },
            Thread: {
                type: "object",
                description: "A Thread definition",
                properties: {
                    name: {
                        description: "The name of the thread (optional)",
                        type: "string"
                    },
                    modelid: {
                        description:
                            "The model id to use (browse here: https://dev.mint.isi.edu/ethiopia/models/explore. Example: cycles-0.10.2-alpha-collection-oromia)",
                        type: "string"
                    },
                    datasets: {
                        description:
                            "A map of input name and dataset ids. Example { cycles_weather_soil: ac34f01b-1484-4403-98ea-3a380838cab1 }. To browse the datasets, go here: http://localhost:8080/ethiopia/datasets/browse",
                        type: "object"
                    },
                    parameters: {
                        description:
                            "A map of parameter name and parameter values. Example: { start_planting_day: [100, 107, 114] }",
                        type: "object"
                    }
                }
            }
        }
    }
};

export default apiDocComponents;
