import{c as u,f as v,r as c,e as f,N as p}from"./index-BO5H17Kp.js";import{p as d}from"./LeaveWorkspaceDialog-GMHeJdAt.js";/**
 * @license lucide-react v0.509.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["polyline",{points:"12 6 12 12 16 14",key:"68esgv"}]],W=u("clock",m);function j(){const{goToWorkspaces:r}=v(),{success:n,error:i}=p(),[t,a]=c.useState(null),[s,o]=c.useState(!1);return{target:t,isLeaving:s,requestLeave:e=>{e.id&&a({id:e.id,name:e.name})},cancelLeave:()=>{s||a(null)},confirmLeave:async()=>{if(!(!t||s)){o(!0);try{await d.leaveWorkspace(t.id),f.getState().leaveProject(t.id),n({title:"Left workspace",description:`You left ${t.name}.`}),a(null),r()}catch(e){const l=e instanceof Error?e.message:"Failed to leave workspace.";i({title:"Could not leave workspace",description:l})}finally{o(!1)}}}}}export{W as C,j as u};
