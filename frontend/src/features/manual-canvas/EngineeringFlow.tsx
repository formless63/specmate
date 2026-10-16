import { memo, useMemo, useRef, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, Handle, Position, Background, Controls, ConnectionMode, applyNodeChanges, type Connection, type Edge, type Node, type NodeProps, type XYPosition, type ReactFlowInstance } from '@xyflow/react';
import { Button } from '@mantine/core';
import { layoutKey } from './layout';
import '@xyflow/react/dist/style.css';
export type FlowPort = { id: string; label: string; side: 'left' | 'right'; color?:string; unknown?:boolean };
export type FlowItem = { id: string; title: string; detail?: string; ports: FlowPort[]; endpointId?: string; position: XYPosition; artwork?:ReactNode };
type FlowData = { title: string; detail?: string; ports: FlowPort[]; endpointId?: string; disabled: boolean; artwork?:ReactNode };
type FlowNode = Node<FlowData, 'engineering'>;
const PartNode = memo(function PartNode({ data }: NodeProps<FlowNode>) {
 return <section className="manual-node" data-canvas-end={data.endpointId}><header>{data.title}</header>{data.detail&&<small>{data.detail}</small>}{data.artwork&&<div className="manual-artwork nodrag">{data.artwork}</div>}{data.ports.map(port=><div className="manual-port" key={port.id}><Handle id={port.id} type="source" position={port.side==='left'?Position.Left:Position.Right} isConnectable={!data.disabled} aria-label={port.label} data-unknown={port.unknown || undefined} style={port.color?{background:port.color}:undefined}/><span>{port.label}</span></div>)}{!data.ports.length&&<small>Terminals not yet resolved</small>}</section>;
});
const NODE_TYPES={engineering:PartNode};
/** Generic view adapter: positions are session layout, handles carry domain-owned identities. */
export function EngineeringFlow(props: {items:FlowItem[];edges:Edge[];disabled:boolean;active:boolean;positions:Record<string,XYPosition>;onPositions:(value:Record<string,XYPosition>)=>void;onConnect:(value:Connection)=>void;onDrop:(raw:string,position:XYPosition,endpointId:string|null)=>void;mime:string}) {
 const flow=useRef<ReactFlowInstance<FlowNode>|null>(null);
 const nodes=useMemo<FlowNode[]>(()=>props.items.map(item=>({id:item.id,type:'engineering',position:props.positions[layoutKey(item.id)]??item.position,data:{title:item.title,detail:item.detail,ports:item.ports,endpointId:item.endpointId,disabled:props.disabled,artwork:item.artwork}})),[props.items,props.positions,props.disabled]);
 if(!props.active)return null;
 return <div className="manual-flow" aria-label="Manual engineering canvas"><ReactFlowProvider><ReactFlow<FlowNode> onInit={value=>{flow.current=value;}} nodes={nodes} edges={props.edges} nodeTypes={NODE_TYPES} connectionMode={ConnectionMode.Loose} nodesConnectable={!props.disabled} edgesReconnectable={false} deleteKeyCode={null} fitView fitViewOptions={{padding:0.2,maxZoom:1}} minZoom={0.2} maxZoom={2} onNodesChange={changes=>{const next=applyNodeChanges(changes,nodes);const positions={...props.positions};next.forEach(node=>{positions[layoutKey(node.id)]=node.position;});props.onPositions(positions);}} onConnect={props.onConnect} onDragOver={event=>{if(props.disabled)return;event.preventDefault();event.dataTransfer.dropEffect='copy';}} onDrop={event=>{event.preventDefault();if(props.disabled)return;const target=event.target instanceof Element?event.target.closest('[data-canvas-end]'):null;props.onDrop(event.dataTransfer.getData(props.mime),flow.current?.screenToFlowPosition({x:event.clientX,y:event.clientY})??{x:0,y:0},target?.getAttribute('data-canvas-end')??null);}}><Background/><Controls showInteractive={false}/><div className="manual-fit"><Button size="compact-xs" onClick={()=>void flow.current?.fitView({padding:0.2,maxZoom:1})}>Fit canvas</Button></div></ReactFlow></ReactFlowProvider></div>;
}
