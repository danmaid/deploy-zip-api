export type RepeatSpec = { sample: number; total: number; label?: string };
export type NodeKind = 'task'|'io'|'tee'|'storage'|'delete'|'spool'|'pipe'|'marker';
export type PlanNode = { id: string; label: string; stage: number; row?: number; kind?: NodeKind; repeat?: RepeatSpec };
export type EdgeShape = 'bezier'|'straight';
export type EdgeStyle = 'normal'|'lifetime'|'use';
export type PlanEdge = { from: string; to: string; label?: string; optional?: boolean; when?: string; shape?: EdgeShape; style?: EdgeStyle };
export type Decoration = { kind: 'totalSpan'; from: string; to: string; metric: string };
export type PipelinePlan = { version: 2; kind: 'download'|'upload'; counts: Record<string, number>; nodes: PlanNode[]; edges: PlanEdge[]; decorations?: Decoration[] };

export function encodePlan(plan: PipelinePlan): string {
  const json = JSON.stringify(plan);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function downloadPlan(fileCount: number): PipelinePlan {
  const nodes: PlanNode[] = [
    { id:'store', label:'storage', stage:-0.35, row:1, kind:'storage' },
    { id:'walk', label:'walk', stage:0, row:1, kind:'task' },
    { id:'lfh', label:'LFH', stage:1, row:1, kind:'task', repeat:{ sample:3, total:fileCount, label:`×${fileCount}` } },
    { id:'deflate', label:'deflate', stage:2, row:1, kind:'task', repeat:{ sample:3, total:fileCount, label:`×${fileCount}` } },
    { id:'dd', label:'DD', stage:3, row:1, kind:'task', repeat:{ sample:3, total:fileCount, label:`×${fileCount}` } },
    { id:'cd', label:'CD', stage:4, row:1, kind:'task' },
    { id:'net', label:'network', stage:5, row:1, kind:'io' },
  ];
  const edges: PlanEdge[] = [
    { from:'store', to:'walk' },
    { from:'walk', to:'lfh' },
    { from:'lfh', to:'deflate' },
    { from:'deflate', to:'dd' },
    { from:'dd', to:'cd' },
    { from:'cd', to:'net' },
  ];
  return { version: 2, kind: 'download', counts: { files: fileCount }, nodes, edges, decorations:[{ kind:'totalSpan', from:'store', to:'net', metric:'total' }] };
}

export function uploadPlan(entryCount: number): PipelinePlan {
  const nodes: PlanNode[] = [
    { id:'net', label:'network', stage:-0.35, row:1, kind:'io' },
    { id:'tee', label:'tee', stage:0, row:1, kind:'tee' },
    { id:'dispatch', label:'dispatch', stage:0.18, row:1, kind:'pipe' },
    { id:'spool_file', label:'spool', stage:0.05, row:3, kind:'spool' },
    { id:'inflate', label:'inflate', stage:1, row:1, kind:'task', repeat:{ sample:3, total:entryCount, label:`×${entryCount}` } },
    { id:'dd', label:'DD verify', stage:2, row:1, kind:'task', repeat:{ sample:3, total:entryCount, label:`×${entryCount}` } },
    { id:'cd', label:'CD', stage:3, row:1, kind:'task' },
    { id:'swap', label:'swap', stage:4, row:1, kind:'task' },
    { id:'cleanup', label:'cleanup', stage:5, row:1, kind:'task' },
    { id:'del', label:'rm', stage:5, row:3, kind:'delete' },
    { id:'spool_use', label:'use', stage:3, row:3, kind:'marker' },
    { id:'store', label:'storage', stage:6, row:1, kind:'storage' },
  ];

  const edges: PlanEdge[] = [
    { from:'net', to:'tee' },
    { from:'tee', to:'dispatch', label:'route', shape:'bezier' },
    { from:'dispatch', to:'inflate' },
    { from:'tee', to:'spool_file', label:'write', shape:'straight' },
    { from:'cd', to:'spool_use', label:'read', optional:true, when:'spool_read', shape:'straight' },
    { from:'spool_use', to:'del', label:'used', optional:true, when:'spool_read', shape:'straight', style:'use' },
    { from:'spool_file', to:'del', label:'lifetime', shape:'straight', style:'lifetime' },
    { from:'cleanup', to:'del', label:'rm', shape:'straight' },
    { from:'inflate', to:'dd' },
    { from:'dd', to:'cd' },
    { from:'cd', to:'swap' },
    { from:'swap', to:'cleanup' },
    { from:'cleanup', to:'store' },
  ];

  return { version: 2, kind: 'upload', counts:{ entries: entryCount }, nodes, edges, decorations:[{ kind:'totalSpan', from:'net', to:'store', metric:'total' }] };
}
