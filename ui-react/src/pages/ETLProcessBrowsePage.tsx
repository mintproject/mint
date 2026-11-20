import { gql, useQuery } from '@apollo/client';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const ETL_PROCESSES = gql`
  query BrowseETLProcesses {
    modelcatalog_etl_process(order_by: { label: asc }) {
      id
      label
      description
      version
      runtime_kind
      visibility
      contracts(order_by: [{ role: asc }, { position: asc }]) {
        role
        standard_variable_uri
        unit
        format
      }
    }
  }
`;

type ETLContract = {
  role: string;
  standard_variable_uri: string;
  unit: string | null;
  format: string | null;
};

type ETLProcess = {
  id: string;
  label: string;
  description: string | null;
  version: string | null;
  runtime_kind: string;
  visibility: string;
  contracts: ETLContract[];
};

type BrowseETLProcessesData = {
  modelcatalog_etl_process: ETLProcess[];
};

export function ETLProcessBrowsePage() {
  const { data, loading, error } = useQuery<BrowseETLProcessesData>(ETL_PROCESSES);
  const processes = data?.modelcatalog_etl_process ?? [];
  return (
    <div className="container min-w-0 max-w-full overflow-x-hidden py-6">
      <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">ETL processes</h1>
          <p className="text-muted-foreground">
            Browse reusable transformations registered in the MINT catalog.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/etl/register-piece">Register a piece</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/etl/approvals">Approvals</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/etl/register">Register ETL process</Link>
          </Button>
        </div>
      </div>
      {loading && <p className="text-muted-foreground">Loading ETL processes…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          Unable to load ETL processes: {error.message}
        </p>
      )}
      {!loading && !error && processes.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No ETL processes have been registered yet.
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {processes.map((process) => {
          const inputs = process.contracts.filter((c) => c.role === 'input');
          const outputs = process.contracts.filter((c) => c.role === 'output');
          return (
            <Card key={process.id} className="min-w-0 overflow-hidden">
              <CardHeader className="min-w-0">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <CardTitle className="min-w-0 break-words">{process.label}</CardTitle>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs">
                    {process.version || 'Unversioned'}
                  </span>
                </div>
                <p className="break-words text-sm text-muted-foreground">
                  {process.description || 'No description provided.'}
                </p>
              </CardHeader>
              <CardContent className="min-w-0 space-y-3 text-sm">
                <div className="flex min-w-0 flex-wrap gap-2">
                  <span className="font-medium">Runtime:</span>
                  <span>
                    {process.runtime_kind === 'tapis_app'
                      ? 'Tapis app/job'
                      : 'Inline Python function'}
                  </span>
                </div>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="font-medium">Inputs</p>
                    {inputs.map((c, i) => (
                      <p key={i} className="break-all text-xs text-muted-foreground">
                        {c.standard_variable_uri}
                        {c.unit ? ` · ${c.unit}` : ''}
                        {c.format ? ` · ${c.format}` : ''}
                      </p>
                    ))}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium">Outputs</p>
                    {outputs.map((c, i) => (
                      <p key={i} className="break-all text-xs text-muted-foreground">
                        {c.standard_variable_uri}
                        {c.unit ? ` · ${c.unit}` : ''}
                        {c.format ? ` · ${c.format}` : ''}
                      </p>
                    ))}
                  </div>
                </div>
                <p className="break-all text-xs text-muted-foreground">{process.id}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
