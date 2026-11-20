import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BoundingBox } from '@/lib/geo/bbox';

export interface UploadSummary {
  title: string;
  organization: string;
  isPublic: boolean;
  license: string;
  description: string;
  author: string;
  contactEmail: string;
  startDate: string;
  endDate: string;
  /** What the coverage is: a region's name, or null for a drawn box. */
  regionName: string | null;
  box: BoundingBox | null;
  files: Array<{ name: string; format: string; description: string }>;
  variable: string;
  tags: string[];
  sourceUrl: string;
  version: string;
}

const dash = (text: string) => text.trim() || 'Not set';
const degrees = (n: number) => String(Math.round(n * 10000) / 10000);

/** "What others will see": the dataset as its catalog page will lay it out. */
export function UploadSummaryCard({ summary: s }: { summary: UploadSummary }) {
  const coverage = s.box
    ? `${s.regionName ? `${s.regionName}: ` : ''}west ${degrees(s.box.xmin)}, south ${degrees(s.box.ymin)}, east ${degrees(s.box.xmax)}, north ${degrees(s.box.ymax)}`
    : 'No spatial area';
  const period = s.startDate && s.endDate ? `${s.startDate} to ${s.endDate}` : 'No dates yet';
  return (
    <Card data-testid="upload-summary">
      <CardHeader>
        <CardTitle className="text-xl">{s.title.trim() || 'Untitled dataset'}</CardTitle>
        <div className="text-sm text-muted-foreground">
          {dash(s.organization)} ·{' '}
          <Badge variant="outline">{s.isPublic ? 'Public' : 'Private'}</Badge> · License:{' '}
          {dash(s.license)}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap">{dash(s.description)}</p>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">Author</dt>
          <dd>{dash(s.author)}</dd>
          <dt className="font-medium">Contact</dt>
          <dd>{dash(s.contactEmail)}</dd>
          <dt className="font-medium">Dates</dt>
          <dd>{period}</dd>
          <dt className="font-medium">Area</dt>
          <dd>{coverage}</dd>
          <dt className="font-medium">Variable</dt>
          <dd>{dash(s.variable)}</dd>
          {s.sourceUrl.trim() && (
            <>
              <dt className="font-medium">Source</dt>
              <dd className="break-all">{s.sourceUrl.trim()}</dd>
            </>
          )}
          {s.version.trim() && (
            <>
              <dt className="font-medium">Version</dt>
              <dd>{s.version.trim()}</dd>
            </>
          )}
        </dl>
        <div>
          <h4 className="font-medium">Files</h4>
          {s.files.length === 0 ? (
            <p className="text-muted-foreground">No files chosen.</p>
          ) : (
            <ul className="space-y-1">
              {s.files.map((f, i) => (
                <li key={`${i}-${f.name}`}>
                  {f.name} ({f.format || 'no format'}; {dash(s.variable)})
                  {f.description.trim() && `: ${f.description.trim()}`}
                </li>
              ))}
            </ul>
          )}
        </div>
        {s.tags.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Tags in summary">
            {s.tags.map((t) => (
              <li key={t}>
                <Badge variant="secondary">{t}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
