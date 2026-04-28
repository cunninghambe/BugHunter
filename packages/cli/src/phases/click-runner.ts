// Click-via-evaluate helper — v0.12.
// Mirrors form-submit-runner.ts: single scope.evaluate round-trip, no snapshot pipeline.
// Called by CamofoxBrowserMcpAdapter (via TabScope.clickWithObservation) and execute.ts.

import type { EvaluateResult } from '../adapters/browser-mcp.js';
import { BrowserMcpError } from '../adapters/browser-mcp-error.js';

/** Minimal scope contract — same shape as form-submit-runner.ts. */
type ClickScope = {
  evaluate(script: string): Promise<EvaluateResult>;
};

export type EvaluateClickReason =
  | 'element_not_in_dom'
  | 'element_not_visible'
  | 'page_eval_threw'
  | 'no_result'
  | 'unknown';

export type AccessibleNameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'title'
  | 'label-for'
  | 'text';

export type EvaluateClickResult =
  | {
      ok: true;
      accessibleNameAbsent: boolean;
      ariaLabelSource: AccessibleNameSource | null;
      tagName: string;
      role: string | null;
    }
  | { ok: false; reason: EvaluateClickReason };

/**
 * Click an element via a single scope.evaluate round-trip — bypasses the
 * camofox a11y-snapshot lookup that fails for icon-only / unnamed elements.
 *
 * Returns the rich EvaluateClickResult so the caller can emit a
 * BugDetection (interactive_element_missing_accessible_name) when
 * ok && accessibleNameAbsent === true.
 *
 * Throws BrowserMcpError('element_not_found') when the element is absent or
 * not visible. Throws BrowserMcpError('evaluate_failed') on transport errors.
 */
export async function runEvaluateClick(
  scope: ClickScope,
  selector: string,
): Promise<EvaluateClickResult & { ok: true }> {
  let result: EvaluateResult;
  try {
    result = await scope.evaluate(buildClickScript(selector));
  } catch (err) {
    throw new BrowserMcpError('evaluate_failed', `click: page_eval_threw: ${String(err)}`, selector);
  }

  if (result.value === undefined) {
    throw new BrowserMcpError('evaluate_failed', `click: no_result (selector=${selector})`, selector);
  }

  const v = result.value as { ok?: boolean; reason?: string } | undefined;

  if (v?.ok !== true) {
    const reason = (v?.reason ?? 'unknown') as EvaluateClickReason;
    if (reason === 'element_not_in_dom' || reason === 'element_not_visible') {
      throw new BrowserMcpError('element_not_found', `click: ${reason} (selector=${selector})`, selector);
    }
    throw new BrowserMcpError('evaluate_failed', `click: ${reason} (selector=${selector})`, selector);
  }

  return result.value as EvaluateClickResult & { ok: true };
}

/**
 * Build the page-side IIFE that clicks the element and reports accessible-name
 * presence. Exported for unit testing only — callers should use runEvaluateClick.
 *
 * Selector is JSON-stringified — no string concatenation at the host/page boundary.
 */
export function buildClickScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(function(){
  var el=document.querySelector(${sel});
  if(!el)return{ok:false,reason:'element_not_in_dom'};
  var r=el.getBoundingClientRect();
  if(el.offsetParent===null&&(r.width===0||r.height===0))return{ok:false,reason:'element_not_visible'};
  var src=null;
  var lbyIds=(el.getAttribute('aria-labelledby')||'').trim();
  if(lbyIds!==''){
    var lbyText=lbyIds.split(/[ \t]+/).map(function(id){var n=document.getElementById(id);return n?n.textContent||'':'';}).join(' ').trim();
    if(lbyText!=='')src='aria-labelledby';
  }
  if(src===null){
    var al=(el.getAttribute('aria-label')||'').trim();
    if(al!=='')src='aria-label';
  }
  if(src===null){
    var ti=(el.getAttribute('title')||'').trim();
    if(ti!=='')src='title';
  }
  if(src===null&&el.id!==''){
    var lbl=document.querySelector('label[for='+JSON.stringify(el.id)+']');
    if(lbl&&(lbl.textContent||'').trim()!=='')src='label-for';
  }
  if(src===null){
    var tc=(el.textContent||'').trim();
    if(tc!=='')src='text';
  }
  el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));
  return{ok:true,accessibleNameAbsent:src===null,ariaLabelSource:src,tagName:el.tagName.toLowerCase(),role:el.getAttribute('role')};
})()`;
}
