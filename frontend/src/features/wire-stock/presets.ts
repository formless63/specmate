import type { StockSpecification } from '../../../../packages/section-layout/src';
import coax from '../../../../tests/fixtures/wire-stock-coax.json';
import pair from '../../../../tests/fixtures/wire-stock-pair.json';
import ribbon from '../../../../tests/fixtures/wire-stock-ribbon.json';
import figureeight from '../../../../tests/fixtures/wire-stock-figure-eight.json';

export const stockPresets: Record<string, StockSpecification> = {
  'coax': coax.stock as StockSpecification,
  'pair': pair.stock as StockSpecification,
  'ribbon': ribbon.stock as StockSpecification,
  'figure-eight': figureeight.stock as StockSpecification,
};
