export type WorkflowRevisionItemType = 'todo' | 'time_boundary' | 'note';

export interface WorkflowRevisionItem {
  type: WorkflowRevisionItemType;
  text: string;
}

const NUMBERED_ITEM_PATTERN = /(^|[\s,，;；。])((?:\d+|[一二三四五六七八九十]+)[.、)）]\s*)/g;
const INTRO_PATTERN =
  /^(?:请|麻烦)?(?:帮我|帮忙)?(?:补充|追加|加上|新增|记录一下|记一下|记录|加一个|加进来)[,，:：\s]*/;
const TIME_PATTERN =
  /(?:今天|明天|今晚|晚上|上午|下午|中午|早上|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}[:：]\d{2}|\d{1,2}\s*[点时])/i;
const EVENT_PATTERN = /(?:活动|音乐会|会议|约|面试|appointment|航班|出门|聚餐|课程|上课|日程|排期|deadline|到期)/i;
const TODO_PATTERN = /(?:报销|提交|处理|完成|联系|写|整理|确认|准备|更新|发送|申请|支付|缴费|review|复盘|核对|检查|预约)/i;

export function formatWorkflowRevisionMemoryNote(text: string): string {
  const items = parseWorkflowRevisionItems(text);
  if (items.length <= 1) return `用户提出修改意见：${text}`;

  return [
    `用户提出修改意见：${text}`,
    '',
    '结构化补充事项：',
    ...items.map((item) => `- [${item.type}] ${item.text}${instructionForType(item.type)}`),
  ].join('\n');
}

export function parseWorkflowRevisionItems(text: string): WorkflowRevisionItem[] {
  return splitRevisionItems(text).map((item) => ({
    type: classifyRevisionItem(item),
    text: item,
  }));
}

function splitRevisionItems(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const body = normalized.replace(INTRO_PATTERN, '').trim();
  const matches = Array.from(body.matchAll(NUMBERED_ITEM_PATTERN));
  if (matches.length < 2) return body ? [body] : [];

  return matches
    .map((match, index) => {
      const start = (match.index || 0) + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1]?.index || body.length : body.length;
      return cleanItem(body.slice(start, end));
    })
    .filter(Boolean);
}

function cleanItem(value: string): string {
  return value.replace(/^[,，;；。:\s]+/, '').replace(/[,，;；\s]+$/, '').trim();
}

function classifyRevisionItem(item: string): WorkflowRevisionItemType {
  const hasTime = TIME_PATTERN.test(item);
  const hasEvent = EVENT_PATTERN.test(item);
  const hasTodo = TODO_PATTERN.test(item);
  if (hasTodo) return 'todo';
  if (hasTime || hasEvent) return 'time_boundary';
  return 'note';
}

function instructionForType(type: WorkflowRevisionItemType): string {
  if (type === 'todo') return '（处理要求：作为新增待办候选显示；如果不放入今日重点，必须说明原因。）';
  if (type === 'time_boundary') return '（处理要求：作为日程/时间边界显示；不要默默忽略。）';
  return '（处理要求：作为用户补充背景显示；不要默默忽略。）';
}
