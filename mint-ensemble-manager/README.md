# mint-ensemble-manager

Ensemble Manager for MINT

## API Documentation

The MINT Ensemble Manager provides a comprehensive REST API for managing ensemble modeling workflows, including problem statements, tasks, subtasks, threads, and job execution.

### Base URL

**Production Server:**

```
https://ensemble-manager.mint.tacc.utexas.edu/v1
```

**Local Development:**

```
http://localhost:3000/v1
```

### Authentication

**⚠️ Security Notice**: The API requires JWT authentication. Include your JWT token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

**Production Access**: The production server requires a TACC account for authentication. Use the client ID `mint-ensemble-manager` when authenticating.

### Interactive Documentation

Access the interactive Swagger UI documentation:

**Production:**

```
https://ensemble-manager.mint.tacc.utexas.edu/v1/ui
```

**Local Development:**

```
http://localhost:3000/v1/ui
```

### Core Concepts

#### Problem Statements

Problem statements define the high-level research questions and scope for your modeling work.

#### Tasks

Tasks represent specific modeling objectives within a problem statement, with defined time periods and regions.

#### Subtasks (formerly Threads)

Subtasks contain the actual model configurations, parameters, and data inputs for execution. **Note**: Subtasks were previously called "Threads" - all thread endpoints are now deprecated.

#### ~~Threads~~ (Deprecated)

**⚠️ DEPRECATED**: Thread endpoints are deprecated and will be removed soon. Use the Subtask endpoints instead.

### API Endpoints

#### Unified execution plans

`/plans` is the browser-facing orchestration boundary for both ordinary
Ensemble Manager runs and SVO-adapter-backed runs. The adapter URL is
server-side; the browser never submits directly to the adapter.

```http
POST /plans
```

For an existing model thread, send `executor: "ensemble_manager"` with
`thread_id`, `model_id`, and the deployment's `execution_engine`. For an
adapter-backed variable, send `executor: "svo_adapter"` and an
`adapter_request` matching the adapter's planning request. The response
contains `plan_id`, `executor`, and plan-scoped `parameters`.

When an Ensemble Manager plan contains `adapter_steps`, the service creates a
durable parent execution, submits the adapter children, and reconciles them
through `GET /plans/runs/{run_id}`. The existing model executor is dispatched
only after every adapter output has a registered resource URI. Parent statuses
include `adapter_running`, `output_verifying`, `model_dispatching`,
`model_submitted`, `failed`, `adapter_unknown`, and `model_unknown`; the
`*_unknown` states are not retried automatically because the downstream
request may have been accepted.

```http
GET /plans/{plan_id}
POST /plans/submit
GET /plans/runs/{run_id}
```

Submission accepts the plan ID, optional `parameter_values`, and optional
`max_minutes` for the model batch-job wall time. `max_minutes` must be a
positive integer and defaults to 60 minutes when omitted. An optional `queue`
names the Tapis logical queue for the model batch job (for example
`development`); when omitted the model app's own queue applies. Adapter plans are
validated against their immutable parameter definitions; missing, unknown, or
invalid required values return `422` and no workflow is started. Ordinary
model plans continue through the existing execution engine path.

Deployments using ordinary plans must configure `unified_plan_secret` in the
Ensemble Manager config (or `UNIFIED_PLAN_SECRET` in the environment); it is
used to sign the opaque legacy plan ID. Do not reuse the Hasura admin secret.

#### Problem Statements

**Create a Problem Statement**

```http
POST /problemStatements
```

**Example Request:**

```json
{
    "name": "Texas Water Management Analysis 2024",
    "regionid": "texas",
    "dates": {
        "start_date": "2024-01-01T00:00:00Z",
        "end_date": "2024-12-31T23:59:59Z"
    },
    "events": [
        {
            "event": "CREATE",
            "userid": "user@example.com",
            "timestamp": "2024-01-15T10:30:00Z",
            "notes": "Initial problem statement creation"
        }
    ],
    "permissions": [
        {
            "userid": "*",
            "read": true,
            "write": false,
            "execute": false,
            "owner": false
        }
    ]
}
```

**List Problem Statements**

```http
GET /problemStatements
```

**Get Problem Statement by ID**

```http
GET /problemStatements/{id}
```

**Create Task and Subtask Together**

```http
POST /problemStatements/{id}/taskAndSubtask
```

**Example Request:**

```json
{
    "task": {
        "name": "Crop Yield Analysis Task",
        "response_variables": ["crop__potential_transpiration_volume_flux"],
        "driving_variables": ["nitrogen__average_of_net_mass_mineralization_rate"],
        "regionid": "ethiopia",
        "dates": {
            "start_date": "2024-01-01T00:00:00Z",
            "end_date": "2024-12-31T23:59:59Z"
        }
    },
    "subtask": {
        "name": "Crop Yield Analysis Subtask",
        "driving_variables": ["nitrogen__average_of_net_mass_mineralization_rate"],
        "response_variables": ["crop__potential_transpiration_volume_flux"],
        "dates": {
            "start_date": "2024-01-01T00:00:00Z",
            "end_date": "2024-12-31T23:59:59Z"
        }
    }
}
```

#### Tasks

**Create a Task**

```http
POST /problemStatements/{problemStatementId}/tasks
```

**Example Request:**

```json
{
    "name": "Crop Yield Analysis Task",
    "dates": {
        "start_date": "2024-01-01T00:00:00Z",
        "end_date": "2024-12-31T23:59:59Z"
    },
    "response_variables": ["crop__potential_transpiration_volume_flux"],
    "driving_variables": ["nitrogen__average_of_net_mass_mineralization_rate"],
    "regionid": "ethiopia"
}
```

**List Tasks for a Problem Statement**

```http
GET /problemStatements/{problemStatementId}/tasks
```

**Get Task by ID**

```http
GET /problemStatements/{problemStatementId}/tasks/{taskId}
```

#### Subtasks

**Create a Subtask**

```http
POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks
```

**Example Request:**

```json
{
    "name": "Crop Yield Analysis Subtask",
    "dates": {
        "start_date": "2024-01-01T00:00:00Z",
        "end_date": "2024-12-31T23:59:59Z"
    },
    "driving_variables": ["nitrogen__average_of_net_mass_mineralization_rate"],
    "response_variables": ["crop__potential_transpiration_volume_flux"],
    "regionid": "texas",
    "dataset_id": "18400624-423c-42b5-ad56-6c73322584bd"
}
```

**Dataset ID Support:**

- The `dataset_id` field is optional and allows you to associate a dataset with the subtask at creation time
- Dataset IDs are fully supported throughout the subtask lifecycle
- You can also configure datasets later using the `/data` endpoint for more detailed dataset specifications

**Add Models to Subtask**

```http
POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/models
```

**Example Request:**

```json
{
    "modelIds": [
        "http://api.models.mint.local/v1.8.0/modelconfigurations/modflow_2005_BartonSprings_avg?username=mint@isi.edu"
    ]
}
```

**Add Parameters to Subtask**

```http
POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/parameters
```

**Example Request:**

```json
{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
    "parameters": [
        {
            "id": "https://w3id.org/okn/i/mint/start_planting_day",
            "value": [100, 107, 114]
        },
        {
            "id": "https://w3id.org/okn/i/mint/nitrogen_application_rate",
            "value": "150"
        }
    ]
}
```

**Add Data to Subtask**

```http
POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/data
```

**Example Request:**

```json
{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
    "data": [
        {
            "id": "https://w3id.org/okn/i/mint/ce32097e-641d-42af-b3f1-477a24cf015a",
            "dataset": {
                "id": "18400624-423c-42b5-ad56-6c73322584bd",
                "resources": [
                    {
                        "id": "9c7b25c4-8cea-4965-a07a-d9b3867f18a9",
                        "url": "https://ckan.tacc.utexas.edu/dataset/18400624-423c-42b5-ad56-6c73322584bd/resource/9c7b25c4-8cea-4965-a07a-d9b3867f18a9/download/barton_springs_2001_2010average.wel"
                    }
                ]
            }
        }
    ]
}
```

**Setup Complete Model Configuration**

```http
POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/setup
```

This endpoint allows you to configure a model, parameters, and data inputs in a single call.

**Submit a Subtask**

```http
POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/submit
```

**Get Data Bindings for a Subtask**

```http
GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/data-bindings?model_id={model_id}
```

**List Subtasks for a Task**

```http
GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks
```

**Get Subtask by ID**

```http
GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}
```

**Get Blueprint for a Subtask**

```http
GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/blueprint?detailed={boolean}
```

This endpoint returns the complete model configuration blueprint for all models in a subtask, showing available parameters and data inputs.

**Query Parameters:**

- `detailed` (optional, boolean, default: false): Controls the level of parameter detail returned
    - `false` or omitted: Returns basic parameter info (id, value) only
    - `true`: Returns full ModelParameter details including type, description, min, max, etc.

## Programmatic Workflow Guide

This section describes how to programmatically use the Ensemble Manager to select models, configure parameters, and bind data for scientific modeling workflows.

### Overview

The typical workflow follows these steps:

1. Create Problem Statement
2. Create Task
3. Create Subtask
4. Select Model Configurations
5. Get Blueprint (to see available parameters and inputs)
6. Configure Parameters
7. Bind Data
8. Submit for Execution

### Step-by-Step Workflow

#### 1. Create Problem Statement

First, establish the research context:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ethiopia Agricultural Productivity Analysis 2024",
    "regionid": "ethiopia",
    "dates": {
      "start_date": "2000-01-01T00:00:00Z",
      "end_date": "2017-12-31T23:59:59Z"
    }
  }'
```

**Copy-paste ready request body:**

```json
{
    "name": "Ethiopia Agricultural Productivity Analysis 2024",
    "regionid": "ethiopia",
    "dates": {
        "start_date": "2000-01-01T00:00:00Z",
        "end_date": "2017-12-31T23:59:59Z"
    }
}
```

#### 2. Create Task

Create a task within the problem statement:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Crop Yield Analysis",
    "dates": {
      "start_date": "2000-01-01T00:00:00Z",
      "end_date": "2017-12-31T23:59:59Z"
    },
    "regionid": "ethiopia"
  }'
```

**Copy-paste ready request body:**

```json
{
    "name": "Crop Yield Analysis",
    "dates": {
        "start_date": "2000-01-01T00:00:00Z",
        "end_date": "2017-12-31T23:59:59Z"
    },
    "regionid": "ethiopia"
}
```

#### 3. Create Subtask

Create a subtask to contain your model configuration:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Cycles Agricultural Analysis",
    "dates": {
      "start_date": "2000-01-01T00:00:00Z",
      "end_date": "2017-12-31T23:59:59Z"
    }
  }'
```

**Copy-paste ready request body:**

```json
{
    "name": "Cycles Agricultural Analysis",
    "dates": {
        "start_date": "2000-01-01T00:00:00Z",
        "end_date": "2017-12-31T23:59:59Z"
    }
}
```

#### 4. Select Model Configurations

Add ModelConfiguration or ModelConfigurationSetup instances to your subtask:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/models" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "modelIds": [
      "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu"
    ]
  }'
```

**Copy-paste ready request body:**

```json
{
    "modelIds": [
        "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu"
    ]
}
```

#### 5. Get Blueprint

Retrieve the complete configuration blueprint to understand available parameters and data inputs:

```bash
curl -X GET "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/blueprint" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**For detailed parameter information (including type, description, min/max values):**

```bash
curl -X GET "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/blueprint?detailed=true" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Example Blueprint Response:**

```json
[
    {
        "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
        "parameters": [
            {
                "id": "https://w3id.org/okn/i/mint/886ebf8c-6f0b-453d-a36c-fc8678c74109",
                "value": "2000"
            },
            {
                "id": "https://w3id.org/okn/i/mint/a7607d91-a832-4f05-85f0-4b9e481ac8e1",
                "value": "2017"
            },
            {
                "id": "https://w3id.org/okn/i/mint/a46a3d56-207e-4f47-a157-00b299b3536b",
                "value": "Maize"
            },
            {
                "id": "https://w3id.org/okn/i/mint/d4b84b70-01ee-4f14-a1fc-357f45af5c1d",
                "value": "100"
            },
            {
                "id": "https://w3id.org/okn/i/mint/6dff2c27-b5b6-4e07-836e-c0075d41d333",
                "value": "149"
            },
            {
                "id": "https://w3id.org/okn/i/mint/e2cd6662-06f2-4d51-a2ab-111e9b84f7df",
                "value": "0"
            },
            {
                "id": "https://w3id.org/okn/i/mint/02cbd74e-40d4-49b9-9ea2-033dd0f461e0",
                "value": "0.05"
            },
            {
                "id": "https://w3id.org/okn/i/mint/768babb7-2685-4a16-b1ee-23623b225c47",
                "value": "FALSE"
            }
        ],
        "inputs": [
            {
                "id": "https://w3id.org/okn/i/mint/13f1ba62-7b1e-45df-bb5c-4cbffc62872a",
                "dataset": {
                    "id": "",
                    "resources": []
                }
            },
            {
                "id": "https://w3id.org/okn/i/mint/493f44ac-8d70-4c41-bfbc-4b6207d72674",
                "dataset": {
                    "id": "",
                    "resources": []
                }
            }
        ]
    }
]
```

#### 6. Configure Parameters

Use the blueprint information to set parameter values:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/parameters" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
    "parameters": [
        {
            "id": "https://w3id.org/okn/i/mint/768babb7-2685-4a16-b1ee-23623b225c47",
            "value": "FALSE"
        },
        {
            "id": "https://w3id.org/okn/i/mint/e2cd6662-06f2-4d51-a2ab-111e9b84f7df",
            "value": "0"
        },
        {
            "id": "https://w3id.org/okn/i/mint/02cbd74e-40d4-49b9-9ea2-033dd0f461e0",
            "value": "0.05"
        },
        {
            "id": "https://w3id.org/okn/i/mint/a46a3d56-207e-4f47-a157-00b299b3536b",
            "value": "Maize"
        },
        {
            "id": "https://w3id.org/okn/i/mint/a7607d91-a832-4f05-85f0-4b9e481ac8e1",
            "value": "2017"
        },
        {
            "id": "https://w3id.org/okn/i/mint/886ebf8c-6f0b-453d-a36c-fc8678c74109",
            "value": "2000"
        },
        {
            "id": "https://w3id.org/okn/i/mint/6dff2c27-b5b6-4e07-836e-c0075d41d333",
            "value": "149"
        },
        {
            "id": "https://w3id.org/okn/i/mint/d4b84b70-01ee-4f14-a1fc-357f45af5c1d",
            "value": "100"
        }
    ]
  }'
```

**Copy-paste ready request body:**

```json
{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
    "parameters": [
        {
            "id": "https://w3id.org/okn/i/mint/768babb7-2685-4a16-b1ee-23623b225c47",
            "value": "FALSE"
        },
        {
            "id": "https://w3id.org/okn/i/mint/e2cd6662-06f2-4d51-a2ab-111e9b84f7df",
            "value": "0"
        },
        {
            "id": "https://w3id.org/okn/i/mint/02cbd74e-40d4-49b9-9ea2-033dd0f461e0",
            "value": "0.05"
        },
        {
            "id": "https://w3id.org/okn/i/mint/a46a3d56-207e-4f47-a157-00b299b3536b",
            "value": "Maize"
        },
        {
            "id": "https://w3id.org/okn/i/mint/a7607d91-a832-4f05-85f0-4b9e481ac8e1",
            "value": "2017"
        },
        {
            "id": "https://w3id.org/okn/i/mint/886ebf8c-6f0b-453d-a36c-fc8678c74109",
            "value": "2000"
        },
        {
            "id": "https://w3id.org/okn/i/mint/6dff2c27-b5b6-4e07-836e-c0075d41d333",
            "value": "149"
        },
        {
            "id": "https://w3id.org/okn/i/mint/d4b84b70-01ee-4f14-a1fc-357f45af5c1d",
            "value": "100"
        }
    ]
}
```

#### 7. Bind Data

Select and bind datasets to model inputs:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/data" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
    "data": [
      {
        "id": "https://w3id.org/okn/i/mint/13f1ba62-7b1e-45df-bb5c-4cbffc62872a",
        "dataset": {
          "id": "oromia-weather-soil-2000-2017",
          "resources": [
            {
              "id": "weather-soil-resource-id",
              "url": "https://data.mint.isi.edu/files/cycles-input-data/oromia/weather-soil/Arsi_Amigna_7.884865046N_40.19527054E.zip"
            }
          ]
        }
      },
      {
        "id": "https://w3id.org/okn/i/mint/493f44ac-8d70-4c41-bfbc-4b6207d72674",
        "dataset": {
          "id": "cycles-crops-configuration",
          "resources": [
            {
              "id": "crops-config-resource-id",
              "url": "https://raw.githubusercontent.com/mintproject/MINT-WorkflowDomain/master/WINGSWorkflowComponents/cycles-0.10.2-beta-collection/data/crops-horn-of-africa.crop"
            }
          ]
        }
      }
    ]
  }'
```

**Copy-paste ready request body:**

```json
{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
    "data": [
        {
            "id": "https://w3id.org/okn/i/mint/13f1ba62-7b1e-45df-bb5c-4cbffc62872a",
            "dataset": {
                "id": "oromia-weather-soil-2000-2017",
                "resources": [
                    {
                        "id": "weather-soil-resource-id",
                        "url": "https://data.mint.isi.edu/files/cycles-input-data/oromia/weather-soil/Arsi_Amigna_7.884865046N_40.19527054E.zip"
                    }
                ]
            }
        },
        {
            "id": "https://w3id.org/okn/i/mint/493f44ac-8d70-4c41-bfbc-4b6207d72674",
            "dataset": {
                "id": "cycles-crops-configuration",
                "resources": [
                    {
                        "id": "crops-config-resource-id",
                        "url": "https://raw.githubusercontent.com/mintproject/MINT-WorkflowDomain/master/WINGSWorkflowComponents/cycles-0.10.2-beta-collection/data/crops-horn-of-africa.crop"
                    }
                ]
            }
        }
    ]
}
```

#### 8. Verify Configuration

Get the updated blueprint to verify your configuration:

```bash
curl -X GET "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/blueprint" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**For detailed verification with full parameter information:**

```bash
curl -X GET "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/blueprint?detailed=true" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**Copy-paste ready:**

```
// 8. Verify Configuration - No request body needed (GET request)
// Add ?detailed=true for full parameter details
```

#### 9. Submit for Execution

Submit the configured subtask for execution:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/submit" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu"
  }'
```

**Copy-paste ready request body:**

```json
{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu"
}
```

### Alternative: One-Step Setup

For convenience, you can configure models, parameters, and data in a single call:

```bash
curl -X POST "https://ensemble-manager.mint.tacc.utexas.edu/v1/problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/setup" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
    "parameters": [
      {
        "id": "https://w3id.org/okn/i/mint/a46a3d56-207e-4f47-a157-00b299b3536b",
        "value": "Teff"
      },
      {
        "id": "https://w3id.org/okn/i/mint/e2cd6662-06f2-4d51-a2ab-111e9b84f7df",
        "value": "150"
      }
    ],
    "data": [
      {
        "id": "https://w3id.org/okn/i/mint/13f1ba62-7b1e-45df-bb5c-4cbffc62872a",
        "dataset": {
          "id": "oromia-weather-soil-2000-2017",
          "resources": [
            {
              "id": "weather-soil-resource-id",
              "url": "https://data.mint.isi.edu/files/cycles-weather-soil/oromia_2000_2017.tar.gz"
            }
          ]
        }
      }
    ]
  }'
```

**Copy-paste ready request body:**

```json
{
    "model_id": "http://api.models.mint.local/v1.8.0/modelconfigurations/f87802e0-b60f-4c9e-97fd-75fad348b7ee?username=mint@isi.edu",
    "parameters": [
        {
            "id": "https://w3id.org/okn/i/mint/a46a3d56-207e-4f47-a157-00b299b3536b",
            "value": "Teff"
        },
        {
            "id": "https://w3id.org/okn/i/mint/e2cd6662-06f2-4d51-a2ab-111e9b84f7df",
            "value": "150"
        }
    ],
    "data": [
        {
            "id": "https://w3id.org/okn/i/mint/13f1ba62-7b1e-45df-bb5c-4cbffc62872a",
            "dataset": {
                "id": "oromia-weather-soil-2000-2017",
                "resources": [
                    {
                        "id": "weather-soil-resource-id",
                        "url": "https://data.mint.isi.edu/files/cycles-weather-soil/oromia_2000_2017.tar.gz"
                    }
                ]
            }
        }
    ]
}
```

### Key Concepts for Programmatic Use

#### Model Selection

- **ModelConfiguration**: Specific model instances with pre-defined parameters
- **ModelConfigurationSetup**: Model templates that allow parameter customization
- Use the `/models` endpoint to add these to your subtask

#### Blueprint-Driven Configuration

- Always call the `/blueprint` endpoint after adding models
- The blueprint shows you exactly what parameters and inputs are available
- Use blueprint information to guide your parameter and data configuration
- Use `?detailed=true` to get comprehensive parameter metadata (type, description, min/max values, etc.)
- Default blueprint returns basic parameter info (id, value) for faster responses

#### Parameter Values

- Parameters can have single values: `"150"`
- Parameters can have multiple values for ensemble runs: `["100", "150", "200"]`
- The system will create execution combinations based on parameter arrays

#### Data Binding

- Each data input requires a dataset with resources
- Resources specify the actual data files to use
- Dataset IDs typically come from CKAN or other data catalogs

#### Error Handling

- Always check HTTP status codes
- 400 errors typically indicate missing required parameters
- 404 errors indicate resources not found
- Use the blueprint endpoint to verify available options

#### Execution Management

**Submit Modeling Thread for Execution**

Deprecated - soon to be removed: Use the `POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/submit` endpoint instead.

```http
POST /executions
```

**Get Execution Logs**

```http
GET /executions/{executionId}/logs
```

**Submit Modeling Thread for Local Execution**

**Deprecated - soon to be removed: Use the `POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/submit` endpoint instead.**

```http
POST /executionsLocal
```

**Delete Local Execution Cache**

**Deprecated - soon to be removed: Use the `POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/submit` endpoint instead.**

```http
DELETE /executionsLocal
```

**Submit Modeling Thread for Execution using Tapis**

```http
POST /executionEngines/tapis
```

#### Execution Queue Management

**Get Current Execution Queue**

```http
GET /executionQueue
```

**Empty Execution Queue**

```http
DELETE /executionQueue
```

#### Monitoring and Logs

**Fetch Logs for an Execution**

**Deprecated - soon to be removed: Use the `GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/logs` endpoint instead.**

```http
GET /logs?ensemble_id={ensemble_id}
```

**Submit Modeling Thread for Monitoring**

```http
POST /monitors
```

**Fetch Execution Status of Modeling Thread**

```http
GET /monitors?scenario_id={scenario_id}&thread_id={thread_id}
```

#### Model Bindings and Cache

**Get Model Bindings**

```http
GET /modelBindings/data?model_id={model_id}
```

**Get Model Parameters**

```http
GET /modelBindings/parameters?model_id={model_id}
```

**Delete Cached Models**

```http
DELETE /modelCache?model_id={model_id}
```

#### Registration

**Register Execution Outputs**

```http
POST /registration
```

#### Tapis Job Management

**Submit Job**

```http
POST /tapis/jobs
```

**Example Request:**

```json
{
    "name": "bae0f0be6dbee791f1841c20f9903afc",
    "appId": "modflow-2005",
    "appVersion": "0.0.6",
    "fileInputs": [
        {
            "name": "bas6",
            "sourceUrl": "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.ba6"
        }
    ],
    "nodeCount": 1,
    "coresPerNode": 1,
    "maxMinutes": 10,
    "archiveSystemId": "ls6",
    "execSystemId": "ls6",
    "execSystemLogicalQueue": "development"
}
```

**Get Job Status**

```http
GET /tapis/jobs/{id}
```

**Get Job Logs**

```http
GET /tapis/jobs/{id}/logs
```

**Register Tapis Execution Outputs**

```http
POST /tapis/executions/{executionId}/outputs
```

**Update Execution Status**

```http
PUT /tapis/threads/{threadId}/executions/{executionId}/status
```

**Webhook for Job Status Change**

```http
POST /tapis/threads/{threadId}/executions/{executionId}/webhook
```

#### Threads (Deprecated)

**⚠️ DEPRECATED**: All thread endpoints are deprecated and will be removed soon. Use the Subtask endpoints instead.

**Create a Thread**

```http
POST /threads
```

**⚠️ DEPRECATED**: Use `POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks` instead.

**Example Request:**

```json
{
    "name": "Model Run Thread",
    "modelid": "cycles-0.10.2-alpha-collection-oromia",
    "datasets": {
        "cycles_weather_soil": "ac34f01b-1484-4403-98ea-3a380838cab1"
    },
    "parameters": {
        "start_planting_day": [100, 107, 114]
    }
}
```

**List Threads**

```http
GET /threads
```

**⚠️ DEPRECATED**: Use `GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks` instead.

**Get Thread by ID**

```http
GET /threads/{id}
```

**⚠️ DEPRECATED**: Use `GET /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}` instead.

### Data Types

#### TimePeriod

```json
{
    "start_date": "2024-01-01T00:00:00Z",
    "end_date": "2024-12-31T23:59:59Z"
}
```

#### MintEvent

```json
{
    "event": "CREATE",
    "userid": "user@example.com",
    "timestamp": "2024-01-15T10:30:00Z",
    "notes": "Event description"
}
```

#### MintPermission

```json
{
    "userid": "*",
    "read": true,
    "write": false,
    "execute": false,
    "owner": false
}
```

### Error Handling

The API returns standard HTTP status codes:

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `404` - Not Found
- `500` - Internal Server Error

Error responses include a JSON object with error details:

```json
{
    "error": "Error message",
    "details": "Additional error details"
}
```

### Rate Limiting

The API implements rate limiting to ensure fair usage. Check the response headers for rate limit information:

- `X-RateLimit-Limit` - Request limit per window
- `X-RateLimit-Remaining` - Remaining requests in current window
- `X-RateLimit-Reset` - Time when the rate limit resets

### Webhooks

The API supports webhook notifications for job status changes. Configure webhooks in your job submission:

```json
{
    "subscriptions": [
        {
            "eventCategoryFilter": "JOB_NEW_STATUS",
            "description": "Job status notifications",
            "enabled": true,
            "deliveryTargets": [
                {
                    "deliveryMethod": "WEBHOOK",
                    "deliveryAddress": "https://your-webhook-endpoint.com/job-updates"
                }
            ]
        }
    ]
}
```

### Getting Started

1. **Obtain Authentication Token**: Get your JWT token from the authentication service.
2. **Create a Problem Statement**: Define your research scope using `POST /problemStatements`
3. **Create Tasks**: Break down your problem into specific objectives using `POST /problemStatements/{problemStatementId}/tasks`
4. **Create Subtasks**: Configure models, parameters, and data using `POST /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks`
5. **Add Models, Parameters, and Data**: Configure your subtask with the necessary components
6. **Submit for Execution**: Execute your modeling workflows using `POST /executions` or `POST /executionEngines/tapis`
7. **Monitor Progress**: Track job status and results using the monitoring endpoints

### Support

For API support and questions:

- **Production**: Interactive documentation: [https://ensemble-manager.mint.tacc.utexas.edu/v1/ui](https://ensemble-manager.mint.tacc.utexas.edu/v1/ui)
- **Local Development**: Interactive documentation: `http://localhost:3000/v1/ui`
- Check the logs for detailed error information
- Ensure your JWT token is valid and not expired
- **Production Access**: Requires a TACC account with client ID `mint-ensemble-manager`

## Environment Variables

The following environment variables need to be configured:

## WARNING

Security has been activated for the API in version 6.0.0. This means that the API is now protected and requires a valid JWT to access.
If you are facing authorization issues, rollback to version 5.0.0.

### Authentication

- `PUBLIC_KEY`: RSA public key in PEM format for JWT verification
- `JWT_ALGORITHMS`: Comma-separated list of JWT algorithms (defaults to RS256)
- `CLIENT_ID`: OAuth2 client ID for Swagger UI
- `AUTHORIZATION_URL`: OAuth2 authorization URL for API documentation

### Server Configuration

- `PORT`: Server port number (defaults to 3000)
- `VERSION`: API version

### Redis Configuration

- `REDIS_URL`: Redis connection URL for the job queues

## GraphQL Type Generation

This project uses GraphQL Code Generator to automatically generate TypeScript types from GraphQL queries and mutations.

### Prerequisites

The project includes the following GraphQL codegen dependencies:

- `@graphql-codegen/cli`: Command-line interface for GraphQL Code Generator
- `@graphql-codegen/client-preset`: Preset for generating TypeScript types
- `@graphql-typed-document-node/core`: Type-safe GraphQL document nodes

### Generating Types

To generate TypeScript types from your GraphQL schema and operations:

```bash
npm run codegen
```

This command will:

1. Read your GraphQL schema
2. Process all `.graphql` files in the project
3. Generate TypeScript types in `src/classes/graphql/types.ts`
4. Create typed document nodes for type-safe GraphQL operations

### Using Generated Types

After running codegen, you can use the generated types in your code:

```typescript
import { ApolloQueryResult } from "@apollo/client";
import { Problem_Statement } from "./types";

// Define typed query result
interface ListProblemStatementsResult {
    problem_statement: Problem_Statement[];
}

// Use in Apollo Client queries
const result: ApolloQueryResult<ListProblemStatementsResult> = await client.query({
    query: listProblemStatementsGQL,
    fetchPolicy: "no-cache"
});
```

### GraphQL Files Structure

GraphQL queries and mutations are organized in the `src/classes/graphql/queries/` directory:

```
src/classes/graphql/queries/
├── problem-statement/
│   ├── list.graphql
│   ├── get.graphql
│   ├── new.graphql
│   └── update.graphql
├── task/
├── thread/
└── execution/
```

### Type Declaration

The project includes a type declaration file (`src/typings/graphql.d.ts`) that allows importing `.graphql` files directly:

```typescript
declare module "*.graphql" {
    import { DocumentNode } from "graphql";
    const Schema: DocumentNode;
    export = Schema;
}
```

## Setup

- Configure MINT servers

```
edit src/config/config.json
```

- Generate GraphQL types (if schema changed)

```
npm run codegen
```

- Start node

```
npm start
```

- Go to http://localhost:3000/v1/ui

## Run history API

The authenticated read-only endpoints below provide a normalized history for a
problem-formulation subtask. Ensemble Manager authorizes the subtask before
assembling legacy execution rows and unified workflow parent records:

```text
GET /v1/threads/{threadId}/runs?model_id=<optional>&limit=<optional>&cursor=<optional>
GET /v1/threads/{threadId}/runs/{runKey}
```

The response includes execution-time inputs and parameters, model/output
identifiers, workflow/provider references, artifact availability, and errors.
Legacy jobs remain standalone when no exact persisted workflow-child
relationship exists; the API never infers a relationship from timestamps or
names. Raw logs and large files remain provider-hosted and are accessed through
authorized references.

Unified adapter-backed runs expose a parent workflow identity with explicit
adapter, model, and output-handoff stages. The model provider execution is
stored as the model stage's child reference, so it remains correlated with the
same workflow for reconciliation and provenance; legacy model jobs remain
available through the legacy execution paths. When one adapter workflow has
been submitted, the run response also exposes `tapis_workflow.workflow_id`
(the Tapis pipeline definition) and `tapis_workflow.run_id` (the provider run
UUID). The local `ue_...` parent ID is only an Ensemble Manager correlation ID.
Refresh/reconciliation polls the Tapis Job UUID when available, so the unified
run does not depend exclusively on a provider webhook reaching the local
development server.

## License

[MIT](https://opensource.org/license/mit). Copyright (c) 2019-2026 MINT.
See [LICENSE](LICENSE).
