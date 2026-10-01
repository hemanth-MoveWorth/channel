import { authorize } from './access.mjs';
import { auditDecision } from './audit.mjs';
import { evaluateTaskPlan } from './context.mjs';
import { transaction } from './database.mjs';
import { rawTask,publicTask,move } from './tasks.mjs';
import { AppError } from './errors.mjs';

export function decideApproval(db,actor,taskId,decision) {
  const task=rawTask(db,taskId);
  authorize(db,actor,task.workspace_id,'approvals:decide');
  if(!['approved','rejected'].includes(decision))throw new AppError(422,'invalid_decision','Unknown approval decision.');
  const outcome=transaction(db,()=>{
    const current=rawTask(db,taskId);
    const pending=db.prepare("SELECT * FROM approvals WHERE task_id=? AND attempt=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1").get(taskId,current.attempt);
    if(current.state!=='awaiting_approval' || !pending) {
      const prior=db.prepare('SELECT status FROM approvals WHERE task_id=? AND attempt=? ORDER BY created_at DESC,id DESC LIMIT 1').get(taskId,current.attempt);
      const replay=prior?.status===decision && (decision==='rejected'?current.state==='cancelled':['working','input_required','completed','failed'].includes(current.state));
      auditDecision(db,{workspaceId:current.workspace_id,actor,taskId,action:`approval.${decision}`,decision:replay?'allow':'deny',reason:replay?'idempotent_decision':'no_pending_approval'});
      return replay?{task:publicTask(current)}:{error:new AppError(409,'no_pending_approval','Task has no pending approval.')};
    }
    if(decision==='approved') {
      const plan=evaluateTaskPlan(db,current);
      if(plan.effect==='deny' || plan.fingerprint!==pending.gate_fingerprint) {
        const reason=plan.effect==='deny'?plan.reason:'approval_stale';
        auditDecision(db,{workspaceId:current.workspace_id,actor,taskId,action:'approval.approved',decision:'deny',reason});
        return {error:new AppError(plan.effect==='deny'?403:409,reason,'Permissions or source access changed; this approval cannot resume the task.')};
      }
    }
    db.prepare('UPDATE approvals SET status=?,decided_by_user_id=?,decided_at=? WHERE id=?').run(decision,actor.user_id,new Date().toISOString(),pending.id);
    auditDecision(db,{workspaceId:current.workspace_id,actor,taskId,action:`approval.${decision}`,decision:decision==='approved'?'allow':'deny',reason:decision==='approved'?'human_approved':'approval_rejected'});
    return {task:publicTask(move(db,current,decision==='approved'?'working':'cancelled',decision==='approved'?'human_approved':'approval_rejected',{approvalDecision:decision,actor}))};
  });
  // Throw after commit so denied and stale decisions are not lost on rollback.
  if(outcome.error)throw outcome.error;
  return outcome.task;
}
