import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StockConstituentFields } from './StockConstituentFields';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('constituent properties expose exact source confidence and edit only selected fact',()=>{
 const content={stock_constituent:{kind:'conductor',source:'Original synthetic source',components:[],values:{outer_diameter_mm:{value:1,unit:'mm',source:'Original synthetic sheet',status:'documented' as const},material:{value:'Copper',unit:null,source:'Synthetic source',status:'documented' as const}}}};
 const change=vi.fn();render(<MantineProvider env="test"><StockConstituentFields content={content} editable change={change}/></MantineProvider>);
 fireEvent.change(screen.getByLabelText('material value'),{target:{value:'Tinned copper'}});
 expect(change).toHaveBeenCalledWith({stock_constituent:{...content.stock_constituent,values:{...content.stock_constituent.values,material:{...content.stock_constituent.values.material,value:'Tinned copper'}}}});
 expect(content.stock_constituent.values.material.value).toBe('Copper');expect(screen.getByText(/Original synthetic source/)).toBeTruthy();
});
