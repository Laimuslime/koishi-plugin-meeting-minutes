import { Context, Schema, h } from 'koishi'

export const name = 'meeting-minutes'

export interface Config {
  apiUrl: string
  apiKey: string
  model: string
  systemPrompt: string
}

export const Config: Schema<Config> = Schema.object({
  apiUrl: Schema.string().description('硅基流动 API 地址').default('https://api.siliconflow.cn/v1/chat/completions'),
  apiKey: Schema.string().role('secret').description('硅基流动 API 密钥 (必填，以 sk- 开头)'),
  model: Schema.string().description('请求的模型名称').default('deepseek-ai/DeepSeek-V3'),
  systemPrompt: Schema.string().description('AI 总结的系统提示词').default('你是一个会议纪要助手，请根据以下两人的辩论或对话内容，总结核心论点和结论。')
})

interface RecordItem {
  userId: string
  username: string
  content: string
}

const records: Record<string, RecordItem[]> = {}
const targetUsers: Record<string, string[]> = {}

export function apply(ctx: Context, config: Config) {
  ctx.command('meeting', '会议纪要功能')

  ctx.command('meeting.start', '开始记录会议')
    .alias('开始会议')
    .option('qq', '-q <qq:string> 指定需要记录的两个QQ号，用逗号隔开')
    .action(({ session, options }) => {
      if (!options.qq) {
        return '请使用 -q 参数指定需要记录的QQ号，例如：开始会议 -q 123,456'
      }

      const qqs = options.qq.split(/[,，]+/).map(q => q.trim()).filter(Boolean)
      if (qqs.length !== 2) {
        return '请提供正好两个QQ号，并使用逗号隔开。'
      }

      const cid = session.cid
      if (targetUsers[cid]) {
        return `当前群已有记录任务正在进行（记录对象：${targetUsers[cid].join(', ')}）。`
      }
      
      targetUsers[cid] = qqs
      records[cid] = []
      return `已开始记录 ${qqs[0]} 和 ${qqs[1]} 的发言。`
    })

  ctx.command('meeting.end', '结束记录并生成纪要')
    .alias('结束会议')
    .action(async ({ session }) => {
      const cid = session.cid
      if (!targetUsers[cid]) {
        return '当前群没有正在进行的记录。'
      }
      
      delete targetUsers[cid]
      const currentRecords = records[cid] || []
      records[cid] = [] 

      if (currentRecords.length === 0) {
        return '本次没有记录到指定用户的任何发言。'
      }

      let summaryText = '未配置 API Key，已跳过 AI 总结阶段。'

      if (config.apiKey) {
        try {
          await session.send('正在呼叫硅基流动 AI 生成总结，请稍候...')
          
          const rawText = currentRecords.map(r => `${r.username}: ${r.content}`).join('\n')
          
          const response = await ctx.http.post(config.apiUrl, {
            model: config.model,
            messages: [
              { role: 'system', content: config.systemPrompt },
              { role: 'user', content: rawText }
            ]
          }, {
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json'
            }
          })
          
          if (response && response.choices && response.choices[0] && response.choices[0].message) {
            summaryText = response.choices[0].message.content
          }
        } catch (error) {
          ctx.logger('meeting-minutes').error(error)
          summaryText = 'AI 总结请求失败，请检查后台日志的 API 配置或网络状态。'
        }
      }

      // 为 AI 节点伪造名字和头像
      const summaryNode = h('message', { 
        userId: session.bot.userId, 
        nickname: 'AI 纪要员',
        avatar: `http://q1.qlogo.cn/g?b=qq&nk=${session.bot.userId}&s=640`
      }, `[AI 总结]\n${summaryText}`)

      // 为发言人节点伪造名字和头像
      const forwardNodes = currentRecords.map(record => {
        return h('message', { 
          userId: record.userId, 
          nickname: record.username,
          avatar: `http://q1.qlogo.cn/g?b=qq&nk=${record.userId}&s=640`
        }, record.content)
      })

      return h('message', { forward: true }, summaryNode, ...forwardNodes)
    })

  ctx.middleware((session, next) => {
    const cid = session.cid
    
    if (targetUsers[cid] && targetUsers[cid].includes(session.userId) && session.content) {
      if (!session.content.includes('开始会议') && !session.content.includes('结束会议')) {
        records[cid].push({
          userId: session.userId,
          username: session.username || session.userId,
          content: session.content
        })
      }
    }
    
    return next()
  })
}
