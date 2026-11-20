# TACC CKAN Data Catalog Integration Tests

This directory contains integration tests for the `TACC_CKAN_DataCatalog` class, which tests the actual integration with the TACC CKAN server.

## Prerequisites

Before running the integration tests, ensure you have:

1. **Valid API Key**: A valid CKAN API key for the TACC CKAN server
2. **Network Access**: Access to `http://ckan.tacc.cloud:5000`
3. **Test Data**: The tests will create test datasets, so ensure you have write permissions

## Running the Tests

### Run all integration tests:

```bash
npm test -- --testPathPattern=".*integration\.test\.ts$"
```

### Run with specific Jest configuration:

```bash
npx jest --config=src/classes/mint/data-catalog/__tests__/jest.integration.config.js
```

### Run with verbose output:

```bash
npm test -- --testPathPattern=".*integration\.test\.ts$" --verbose
```

## Test Coverage

The integration tests cover the following functionality:

### 1. Connection Testing

- ✅ Test connection to CKAN server
- ✅ Verify correct catalog type identification

### 2. Dataset Registration

- ✅ Register new datasets with organization

### 3. Dataset Search

- ✅ Search by dataset IDs

### 4. Dataset Retrieval

- ✅ Retrieve specific dataset by ID
- ✅ Handle non-existent datasets gracefully

### 5. Data Transformation

- ✅ Transform CKAN package data to MINT Dataset format
- ✅ Extract temporal coverage from extras
- ✅ Extract spatial coverage from extras
- ✅ Map resources and tags correctly

### 6. Error Handling

- ✅ Handle network errors gracefully
- ✅ Handle invalid API keys
- ✅ Proper error propagation

## Test Data

The tests create the following test datasets:

- `test-dataset-integration`: Main test dataset with temperature and precipitation variables
- `test-dataset-no-org`: Test dataset without organization

## Configuration

The tests use the following configuration:

- **API URL**: `http://ckan.tacc.cloud:5000`
- **API Key**: Configured in the test file
- **Timeout**: 60 seconds for network operations
- **Test Organization**: `test-org`

## Notes

- These are **integration tests** that require a live connection to the TACC CKAN server
- Tests may take longer to run due to network latency
- Test datasets are created during the test run - consider cleanup if needed
- The tests use real API calls, so ensure you have proper permissions

## Troubleshooting

### Common Issues:

1. **Connection Timeout**: Check network connectivity to the CKAN server
2. **Authentication Errors**: Verify the API key is valid and has proper permissions
3. **Dataset Creation Failures**: Ensure you have write permissions to create datasets
4. **Search Failures**: Verify the CKAN server is responding correctly

### Debug Mode:

Run tests with debug output:

```bash
DEBUG=* npm test -- --testPathPattern=".*integration\.test\.ts$"
```

## Cleanup

The tests currently don't include automatic cleanup of test datasets. If you need to clean up test data manually, you can:

1. Access the CKAN web interface
2. Search for datasets with names starting with "test-dataset-"
3. Delete them manually if needed

**Note**: In a production environment, you might want to add cleanup methods to the data catalog interface for automated test cleanup.
