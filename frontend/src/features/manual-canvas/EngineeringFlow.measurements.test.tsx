import {MantineProvider} from '@mantine/core';
import {fireEvent,render,screen,cleanup} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
vi.mock('@xyflow/react',async()=>{
 const actual=await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
 return {...actual,ReactFlowProvider:({children}:{children:React.ReactNode})=>children,ReactFlow:({nodes,onNodesChange}:{nodes:import('@xyflow/react').Node[];onNodesChange:(changes:import('@xyflow/react').NodeChange[])=>void})=><div><output aria-label="Measured nodes">{JSON.stringify(nodes)}</output><button onClick={()=>onNodesChange([{type:'dimensions',id:'stock',dimensions:{width:210,height:420}},{type:'select',id:'stock',selected:true}])}>Measure canvas node</button><button onClick={()=>onNodesChange([{type:'position',id:'stock',position:{x:80,y:90},dragging:false}])}>Move canvas node</button></div>,Background:()=>null,Controls:()=>null};
});
import {EngineeringFlow} from './EngineeringFlow';
afterEach(cleanup);
test('node measurement survives controlled layout updates without writing measurement events as layout',()=>{
 const positions=vi.fn(),items=[{id:'stock',title:'Stock',ports:[],position:{x:0,y:0}}];
 const tree=(title='Stock')=><MantineProvider env="test"><EngineeringFlow active disabled={false} items={items.map(item=>({...item,title}))} edges={[]} positions={{}} onPositions={positions} onConnect={vi.fn()} onDrop={vi.fn()} mime="test"/></MantineProvider>;
 const view=render(tree());fireEvent.click(screen.getByRole('button',{name:'Measure canvas node'}));
 expect(positions).not.toHaveBeenCalled();
 view.rerender(tree('Renamed stock'));
 const node=JSON.parse(screen.getByLabelText('Measured nodes').textContent!)[0];
 expect(node).toMatchObject({measured:{width:210,height:420},selected:true,data:{title:'Renamed stock'}});
 fireEvent.click(screen.getByRole('button',{name:'Move canvas node'}));expect(positions).toHaveBeenCalledOnce();expect(Object.values(positions.mock.calls[0]![0])).toEqual([{x:80,y:90}]);
});
