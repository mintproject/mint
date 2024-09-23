MINT uses [hasura](https://hasura.io/) to store the task, problem, execution and other metadata.

The Hasura database is password protected. The default secret is `CHANGEME` can change the username and password by editing the `values.yaml` file in the `mint` directory. The `values.yaml` file contains the following sections:

The default url is [http://graphql.mint.local](http://graphql.mint.local)

```yml
secrets:
  hasura:
    # -- Admin secret for Hasura used to access the console
    admin_secret: CHANGEME
```
