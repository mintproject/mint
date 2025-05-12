# Working with Setups

!!! Warning

    Please make sure you have completed the User guide before you start.

    A ModelConfigurationSetup is executable if:

    - Has a valid ComponentLocation
    - All input files have at least one Variable associated or are fixed files

## What is a Setup?

A setup is the most specific level of configuration, providing concrete values for:

- Input Files: Required data files and model components
- Input Parameters: Configuration values and settings
- Outputs: Expected results and output specifications

## Creating and Managing Setups

### 1. Access Setup Interface

- Select or create a setup from the left panel
  ![](../../figures/walkthrough/35.png)

### 2. Setup Configuration

#### Input Files

- Select specific input data files
- Configure model component locations
- Set file validation rules
- Define file collections
  ![](../../figures/walkthrough/36.png)

#### Input Parameters

- Set specific parameter values
- Configure user-adjustable settings
- Define parameter ranges
- Set default values
  ![](../../figures/walkthrough/37.png)

#### Outputs

- Define expected output files
- Specify output formats
- Configure output validation
- Set output naming conventions
  ![](../../figures/walkthrough/39.png)

## Parameter Configuration in Setups

In setups, you can:

- Set pre-selected values for parameters
- Mark parameters as user-adjustable
- Define parameter ranges
- Set default values
  ![](../../figures/walkthrough/38.png)

## File Configuration in Setups

For input files, you can:

- Select specific files
- Define file collections
- Set default selections
- Configure file validation
  ![](../../figures/walkthrough/39.png)

## Output Configuration in Setups

For outputs, you can:

- Define output file formats
- Specify output variable requirements
- Set output validation rules
- Configure output naming patterns

## Next Steps

Now that you understand how to create and manage setups, proceed to [making your configuration executable](making-executable.md) to ensure your setup can be run successfully.
