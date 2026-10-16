import {MantineProvider} from '@mantine/core';
import {fireEvent,render,screen,cleanup} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
const viewportCalls=vi.hoisted(()=>({center:vi.fn(),viewport:vi.fn()}));
vi.mock('@xyflow/react',async()=>{
 const actual=await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
 return {...actual,ReactFlowProvider:({children}:{children:React.ReactNode})=>children,ReactFlow:({nodes,onNodesChange,onInit}:{onInit?:(value:unknown)=>void;nodes:import('@xyflow/react').Node[];onNodesChange:(changes:import('@xyflow/react').NodeChange[])=>void})=><div><button onClick={()=>onInit?.({setCenter:viewportCalls.center,setViewport:viewportCalls.viewport})}>Initialize viewport</button><output aria-label="Measured nodes">{JSON.stringify(nodes)}</output><button onClick={()=>onNodesChange([{type:'dimensions',id:'stock',dimensions:{width:210,height:420}},{type:'select',id:'stock',selected:true}])}>Measure canvas node</button><button onClick={()=>onNodesChange([{type:'position',id:'stock',position:{x:80,y:90},dragging:false}])}>Move canvas node</button></div>,Background:()=>null,Controls:()=>null};
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

test('readable first focus uses scoped node position while a remembered viewport takes precedence',()=>{viewportCalls.center.mockClear();viewportCalls.viewport.mockClear();const props={active:true,disabled:false,items:[{id:'stock',title:'Stock',ports:[],position:{x:340,y:60}}],edges:[],positions:{},onPositions:vi.fn(),onConnect:vi.fn(),onDrop:vi.fn(),mime:'test',initialFocusId:'stock'};const view=render(<MantineProvider env="test"><EngineeringFlow {...props}/></MantineProvider>);fireEvent.click(screen.getByRole('button',{name:'Initialize viewport'}));expect(viewportCalls.center).toHaveBeenCalledWith(445,300,{zoom:0.9});view.rerender(<MantineProvider env="test"><EngineeringFlow {...props} initialViewport={{x:10,y:20,zoom:1.1}}/></MantineProvider>);fireEvent.click(screen.getByRole('button',{name:'Initialize viewport'}));expect(viewportCalls.viewport).toHaveBeenCalledWith({x:10,y:20,zoom:1.1});expect(viewportCalls.center).toHaveBeenCalledOnce();});
