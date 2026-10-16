import { StockRecordPage } from '../features/wire-stock/StockRecordPage';
import { exampleCoax, generate } from '../features/wire-stock/builder';
import type { StockSpecification } from '../../../packages/section-layout/src';
/** Current stock record, initialized from an original synthetic construction. */
export function NewStockRecord({ stock = generate(exampleCoax()) }: { stock?: StockSpecification }) {
 return <StockRecordPage active principalKey="test" workspaceId="ws" definitionId={null} revisionNumber={null} draftRequested={false}
  initial={{ name: 'Synthetic stock', stock }} projects={[]} onBack={() => {}} onSelect={() => {}} onCreated={() => {}} onOpenInProject={() => {}} />;
}
