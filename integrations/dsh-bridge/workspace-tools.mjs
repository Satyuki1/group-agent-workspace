import {browserResource} from './browser-resource.mjs';

export const name = 'group-workspace-tools';
export const inject = ['tools'];

/** Uses the pinned native tool pipeline, so calls and results enter the Session log. */
export async function apply(ctx) {
  const {defineTool} = await import('../../upstream/deepseek-harness/packages/core/tools/lib/index.js');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'open_browser',
    description: 'Publish an HTTP(S) page to this conversation’s shared workspace. Members following the live workspace see it in a native browser tab. This opens a page for people; it does not read the page or control clicks, forms, or login state. Use when the user asks to open a website.',
    parameters: {url: {type: 'string', required: true, description: 'Complete HTTP(S) URL without embedded credentials.'}},
    output: {
      schema: {type: 'object', additionalProperties: false, properties: {url: {type: 'string', required: true}}},
      render: (_args, value) => [{type: 'text', text: `网页入口已发布到共享工作区：${value.url}。在线成员可在原生浏览器标签查看；未读取网页内容。`}],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const resource = browserResource(args);
      if (!resource) throw new Error('请输入不含账号密码的完整 HTTP(S) 地址。');
      return {url: resource.url};
    },
  })), 'group browser resource tool');
}
