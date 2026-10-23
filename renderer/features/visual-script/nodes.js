// The node type registry and the built-in node library. Titles, categories, descriptions and labels are English
// here and translated by the caller with tr(); locales/ko.json has every one of them.
//
// compile hooks (called by codegen.js with a context `c`, see there):
//   pure node:  expr(c, outPin) -> {code, prec}
//   exec node:  stmt(c) -> the exec output pin that runs next (or null); output(c, pin) -> {code, prec} for a data
//               output that is not a generated local
//   entry node: entry(c) (Start, Define Function)
(function (root) {
  'use strict';
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});
  const tr = VS.tr;

  const registry = new Map();
  VS.registerNodeType = (def) => {
    if (!def || typeof def.type !== 'string') throw new Error('A node type needs a "type".');
    registry.set(def.type, {
      exec: { in: false, out: [] },
      inputs: [],
      outputs: [],
      props: [],
      keywords: '',
      description: '',
      ...def,
    });
  };
  VS.nodeTypes = () => [...registry.values()];
  VS.nodeType = (type) => registry.get(type) || null;

  VS.CATEGORIES = ['Flow', 'Variables', 'Values', 'Math', 'Text', 'Input/Output', 'Lists', 'Functions', 'Python', 'Other'];
  VS.TYPES = ['any', 'number', 'int', 'string', 'bool', 'list', 'dict', 'none'];
  const TYPE_LABELS = { any: 'Any', number: 'Number', int: 'Integer', string: 'Text', bool: 'True/False', list: 'List', dict: 'Dictionary', none: 'None', exec: 'Run order' };
  VS.typeLabel = (type) => tr(TYPE_LABELS[type] || type);

  VS.propOf = (node, key) => {
    if (node.props && node.props[key] !== undefined) return node.props[key];
    const def = VS.nodeType(node.type);
    const p = def && def.props.find((x) => x.id === key);
    return p ? p.default : undefined;
  };
  const propsOf = (node) => {
    const def = VS.nodeType(node.type);
    const out = {};
    for (const p of def ? def.props : []) out[p.id] = VS.propOf(node, p.id);
    return { ...out, ...(node.props || {}) };
  };

  VS.titleOf = (node) => {
    const def = VS.nodeType(node.type);
    if (!def) return node.type;
    return typeof def.title === 'function' ? def.title(propsOf(node)) : tr(def.title);
  };
  // A short detail shown after the title (the variable or function name, the operator); '' when there is none.
  VS.subtitleOf = (node) => {
    const def = VS.nodeType(node.type);
    return def && def.subtitle ? String(def.subtitle(propsOf(node)) || '') : '';
  };

  // {execIn, execOut: [{id, label}], inputs: [{id, label, type, default?, optional?}], outputs: [{id, label, type}]}
  VS.pinsOf = (node, graph) => {
    const def = VS.nodeType(node.type);
    if (!def) return { execIn: false, execOut: [], inputs: [], outputs: [] };
    const g = graph || (VS.ownerGraph && VS.ownerGraph(node)) || { nodes: [node], links: [] };
    const dyn = def.pins ? def.pins(node, g) || {} : {};
    const exec = dyn.exec || def.exec;
    return {
      execIn: !!exec.in,
      execOut: exec.out || [],
      inputs: dyn.inputs || def.inputs,
      outputs: dyn.outputs || def.outputs,
    };
  };

  // "a, b" -> ['a', 'b'] (commas or spaces, duplicates dropped).
  VS.parseNames = (text) => [...new Set(String(text || '').split(/[\s,]+/).filter(Boolean))];

  // The Define Function node named `name` in the graph, or null.
  VS.findFunction = (graph, name) => (graph.nodes || [])
    .filter((n) => n.type === 'fn.define' && VS.propOf(n, 'name') === name)
    .sort((a, b) => VS.compareIds(a.id, b.id))[0] || null;
  VS.functionNames = (graph) => [...new Set((graph.nodes || [])
    .filter((n) => n.type === 'fn.define').map((n) => VS.propOf(n, 'name')).filter(Boolean))].sort();

  // "Hello {name:>5}!" -> {parts: ['Hello ', {field: 'name', conv: '', spec: '>5'}, '!'], fields: ['name'], error}
  VS.templateFields = (template) => {
    const s = String(template || '');
    const parts = [];
    const fields = [];
    let text = '';
    let error = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if ((ch === '{' || ch === '}') && s[i + 1] === ch) {
        text += ch;
        i++;
      } else if (ch === '{') {
        const close = s.indexOf('}', i);
        if (close < 0) {
          error = error || 'unclosed';
          text += s.slice(i);
          break;
        }
        const m = /^([^!:]*)(?:!([rsa]))?(?::(.*))?$/s.exec(s.slice(i + 1, close));
        const field = m ? m[1].trim() : '';
        if (!m || !field) error = error || 'empty';
        if (text) parts.push(text);
        text = '';
        parts.push({ field, conv: (m && m[2]) || '', spec: (m && m[3]) || '' });
        if (field && !fields.includes(field)) fields.push(field);
        i = close;
      } else if (ch === '}') {
        error = error || 'unopened';
        text += ch;
      } else {
        text += ch;
      }
    }
    if (text) parts.push(text);
    return { parts, fields, error };
  };

  const count = (node, key, max = 32) => {
    const v = Math.floor(Number(VS.propOf(node, key)));
    return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0;
  };
  const NEXT = [{ id: 'next', label: '' }];
  const EXEC = { in: true, out: NEXT };
  const LOOP = { in: true, out: [{ id: 'body', label: 'Loop body' }, { id: 'done', label: 'Done' }] };
  const out = (id, label, type) => [{ id, label, type }];

  const reg = VS.registerNodeType;

  // ---------- Flow ----------
  reg({
    type: 'core.start', category: 'Flow', title: 'Start',
    description: 'Where the script begins. A script has exactly one Start node.',
    keywords: 'begin main entry 시작 메인',
    exec: { in: false, out: NEXT },
    compile: { entry(c) { c.line('def main():'); c.block('next'); } },
  });
  reg({
    type: 'flow.if', category: 'Flow', title: 'If',
    description: 'Runs Then when the condition is true, otherwise Else.',
    keywords: 'branch condition else 만약 조건 분기',
    exec: { in: true, out: [{ id: 'then', label: 'Then' }, { id: 'else', label: 'Else' }] },
    inputs: [{ id: 'cond', label: 'Condition', type: 'bool' }],
    compile: {
      stmt(c) {
        c.line(`if ${c.arg('cond')}:`);
        c.block('then');
        if (c.execLinked('else')) {
          c.line('else:');
          c.block('else');
        }
        return null;
      },
    },
  });
  reg({
    type: 'flow.while', category: 'Flow', title: 'While',
    description: 'Repeats Loop body as long as the condition is true, then runs Done.',
    keywords: 'loop repeat 반복 동안',
    exec: LOOP,
    inputs: [{ id: 'cond', label: 'Condition', type: 'bool' }],
    compile: {
      stmt(c) {
        c.line(`while ${c.arg('cond')}:`);
        c.block('body', { loop: true });
        return 'done';
      },
    },
  });
  reg({
    type: 'flow.forRange', category: 'Flow', title: 'For Range',
    description: 'Counts from Start up to (not including) Stop and runs Loop body for each number.',
    keywords: 'loop range count repeat times 반복 범위 횟수',
    exec: LOOP,
    inputs: [
      { id: 'start', label: 'Start', type: 'number', default: 0 },
      { id: 'stop', label: 'Stop', type: 'number', default: 10 },
      { id: 'step', label: 'Step', type: 'number', default: 1 },
    ],
    outputs: out('index', 'Index', 'int'),
    compile: {
      stmt(c) {
        const plain = (pin, v) => !c.linked(pin) && c.input(pin).value === v;
        const args = plain('step', 1)
          ? (plain('start', 0) ? [c.arg('stop')] : [c.arg('start'), c.arg('stop')])
          : [c.arg('start'), c.arg('stop'), c.arg('step')];
        c.line(`for ${c.used('index') ? c.local('index') : '_'} in range(${args.join(', ')}):`);
        c.block('body', { loop: true });
        return 'done';
      },
    },
  });
  reg({
    type: 'flow.forEach', category: 'Flow', title: 'For Each',
    description: 'Runs Loop body once for every item of a list.',
    keywords: 'loop each list items iterate 반복 각각 목록',
    exec: LOOP,
    inputs: [{ id: 'list', label: 'List', type: 'list' }],
    outputs: out('item', 'Item', 'any'),
    compile: {
      stmt(c) {
        c.line(`for ${c.used('item') ? c.local('item') : '_'} in ${c.arg('list')}:`);
        c.block('body', { loop: true });
        return 'done';
      },
    },
  });
  reg({
    type: 'flow.break', category: 'Flow', title: 'Break',
    description: 'Leaves the loop it is in right away.',
    keywords: 'stop exit loop 중단 탈출',
    exec: { in: true, out: [] },
    compile: {
      stmt(c) {
        if (!c.inLoop) return c.fail(c.tr('Break can only be used inside a loop body.'));
        c.line('break');
        return null;
      },
    },
  });
  reg({
    type: 'flow.continue', category: 'Flow', title: 'Continue',
    description: 'Skips the rest of this loop round and starts the next one.',
    keywords: 'skip next loop 계속 건너뛰기',
    exec: { in: true, out: [] },
    compile: {
      stmt(c) {
        if (!c.inLoop) return c.fail(c.tr('Continue can only be used inside a loop body.'));
        c.line('continue');
        return null;
      },
    },
  });

  // ---------- Variables ----------
  reg({
    type: 'var.set', category: 'Variables', title: 'Set Variable',
    description: 'Stores a value under a name so later steps can use it.',
    keywords: 'assign store variable 변수 저장 대입',
    exec: EXEC,
    props: [{ id: 'name', label: 'Name', kind: 'identifier', default: 'x' }],
    inputs: [{ id: 'value', label: 'Value', type: 'any' }],
    subtitle: (p) => p.name,
    compile: {
      stmt(c) {
        const name = c.ident('name');
        c.line(`${name} = ${c.arg('value', -1)}`);
        return 'next';
      },
    },
  });
  reg({
    type: 'var.get', category: 'Variables', title: 'Get Variable',
    description: 'Reads the value stored under a name by Set Variable.',
    keywords: 'read variable value 변수 읽기 가져오기',
    props: [{ id: 'name', label: 'Name', kind: 'identifier', default: 'x' }],
    outputs: out('value', 'Value', 'any'),
    subtitle: (p) => p.name,
    compile: { expr: (c) => ({ code: c.variable('name'), prec: c.P.ATOM }) },
  });

  // ---------- Values ----------
  reg({
    type: 'value.number', category: 'Values', title: 'Number',
    description: 'A number you type in.',
    keywords: 'number constant integer float 숫자 수',
    props: [{ id: 'value', label: 'Value', kind: 'number', default: 0 }],
    outputs: out('value', 'Value', 'number'),
    subtitle: (p) => String(p.value),
    compile: { expr: (c) => c.literal(c.prop('value'), 'number') },
  });
  reg({
    type: 'value.text', category: 'Values', title: 'Text',
    description: 'A piece of text you type in.',
    keywords: 'string text constant 문자열 글자 텍스트',
    props: [{ id: 'value', label: 'Value', kind: 'string', default: '' }],
    outputs: out('value', 'Value', 'string'),
    compile: { expr: (c) => c.literal(String(c.prop('value') ?? ''), 'string') },
  });
  reg({
    type: 'value.bool', category: 'Values', title: 'True/False',
    description: 'The value True or False.',
    keywords: 'boolean true false yes no 참 거짓 불리언',
    props: [{ id: 'value', label: 'Value', kind: 'bool', default: true }],
    outputs: out('value', 'Value', 'bool'),
    subtitle: (p) => (p.value ? 'True' : 'False'),
    compile: { expr: (c) => c.literal(!!c.prop('value'), 'bool') },
  });
  reg({
    type: 'value.none', category: 'Values', title: 'None',
    description: 'The value None, which means "nothing".',
    keywords: 'null nothing empty 없음 널',
    outputs: out('value', 'Value', 'none'),
    compile: { expr: (c) => ({ code: 'None', prec: c.P.ATOM }) },
  });
  reg({
    type: 'value.list', category: 'Values', title: 'Make List',
    description: 'Makes a list from the items connected to it.',
    keywords: 'list array items collection 목록 리스트 배열 만들기',
    props: [{ id: 'count', label: 'Number of items', kind: 'number', default: 2, min: 0, max: 32 }],
    outputs: out('list', 'List', 'list'),
    pins: (node) => ({
      inputs: Array.from({ length: count(node, 'count') }, (_, i) => ({ id: `item${i}`, label: tr('Item {n}', { n: i + 1 }), type: 'any' })),
    }),
    compile: {
      expr: (c) => ({ code: `[${c.pins.inputs.map((p) => c.arg(p.id)).join(', ')}]`, prec: c.P.ATOM }),
    },
  });

  // ---------- Math ----------
  const MATH_PREC = { '+': 'ADD', '-': 'ADD', '*': 'MUL', '/': 'MUL', '//': 'MUL', '%': 'MUL', '**': 'POW' };
  const binary = (c, op, prec) => {
    const p = c.P[prec];
    if (op === '**') return { code: `${c.arg('a', p + 1)} ** ${c.arg('b', c.P.UNARY)}`, prec: p };
    if (prec === 'CMP') return { code: `${c.arg('a', p + 1)} ${op} ${c.arg('b', p + 1)}`, prec: p };
    return { code: `${c.arg('a', p)} ${op} ${c.arg('b', p + 1)}`, prec: p };
  };
  reg({
    type: 'math.binary', category: 'Math', title: 'Math',
    description: 'Adds, subtracts, multiplies or divides two numbers.',
    keywords: 'add plus subtract minus multiply times divide power modulo + - * / 더하기 빼기 곱하기 나누기 계산',
    props: [{ id: 'op', label: 'Operator', kind: 'select', options: ['+', '-', '*', '/', '//', '%', '**'], default: '+' }],
    inputs: [{ id: 'a', label: 'A', type: 'number', default: 0 }, { id: 'b', label: 'B', type: 'number', default: 0 }],
    outputs: out('result', 'Result', 'number'),
    subtitle: (p) => p.op,
    compile: {
      expr(c) {
        const op = c.prop('op');
        if (!MATH_PREC[op]) {
          c.fail(c.tr('Unknown operator "{op}".', { op }));
          return { code: 'None', prec: c.P.ATOM };
        }
        return binary(c, op, MATH_PREC[op]);
      },
    },
  });
  reg({
    type: 'math.compare', category: 'Math', title: 'Compare',
    description: 'Compares two values and gives True or False.',
    keywords: 'equal less greater compare == != < > 같다 비교 크다 작다',
    props: [{ id: 'op', label: 'Operator', kind: 'select', options: ['==', '!=', '<', '<=', '>', '>='], default: '==' }],
    inputs: [{ id: 'a', label: 'A', type: 'any', default: 0 }, { id: 'b', label: 'B', type: 'any', default: 0 }],
    outputs: out('result', 'Result', 'bool'),
    subtitle: (p) => p.op,
    compile: {
      expr(c) {
        const op = c.prop('op');
        if (!['==', '!=', '<', '<=', '>', '>='].includes(op)) {
          c.fail(c.tr('Unknown operator "{op}".', { op }));
          return { code: 'None', prec: c.P.ATOM };
        }
        return binary(c, op, 'CMP');
      },
    },
  });
  reg({
    type: 'math.and', category: 'Math', title: 'And',
    description: 'True only when both A and B are true.',
    keywords: 'and both logic 그리고 논리',
    inputs: [{ id: 'a', label: 'A', type: 'bool', default: false }, { id: 'b', label: 'B', type: 'bool', default: false }],
    outputs: out('result', 'Result', 'bool'),
    compile: { expr: (c) => binary(c, 'and', 'AND') },
  });
  reg({
    type: 'math.or', category: 'Math', title: 'Or',
    description: 'True when A or B (or both) is true.',
    keywords: 'or either logic 또는 논리',
    inputs: [{ id: 'a', label: 'A', type: 'bool', default: false }, { id: 'b', label: 'B', type: 'bool', default: false }],
    outputs: out('result', 'Result', 'bool'),
    compile: { expr: (c) => binary(c, 'or', 'OR') },
  });
  reg({
    type: 'math.not', category: 'Math', title: 'Not',
    description: 'Turns True into False and False into True.',
    keywords: 'not invert logic 아님 반대 논리',
    inputs: [{ id: 'value', label: 'Value', type: 'bool', default: false }],
    outputs: out('result', 'Result', 'bool'),
    compile: { expr: (c) => ({ code: `not ${c.arg('value', c.P.NOT)}`, prec: c.P.NOT }) },
  });
  reg({
    type: 'math.negate', category: 'Math', title: 'Negate',
    description: 'Flips the sign of a number (5 becomes -5).',
    keywords: 'minus negative sign 음수 부호',
    inputs: [{ id: 'value', label: 'Value', type: 'number', default: 0 }],
    outputs: out('result', 'Result', 'number'),
    compile: {
      expr(c) {
        const v = c.arg('value', c.P.UNARY);
        return { code: v.startsWith('-') ? `-(${v})` : `-${v}`, prec: c.P.UNARY };
      },
    },
  });

  // ---------- Text ----------
  reg({
    type: 'text.join', category: 'Text', title: 'Join Text',
    description: 'Puts two values together as one piece of text.',
    keywords: 'concat concatenate join append string 합치기 이어 붙이기 문자열',
    inputs: [{ id: 'a', label: 'A', type: 'any', default: '' }, { id: 'b', label: 'B', type: 'any', default: '' }],
    outputs: out('text', 'Text', 'string'),
    compile: {
      expr(c) {
        const side = (pin, min) => (c.input(pin).type === 'string' ? c.arg(pin, min) : `str(${c.arg(pin)})`);
        return { code: `${side('a', c.P.ADD)} + ${side('b', c.P.ADD + 1)}`, prec: c.P.ADD };
      },
    },
  });
  const convert = (type, title, fn, outType, description, keywords) => reg({
    type, category: 'Text', title, description, keywords,
    inputs: [{ id: 'value', label: 'Value', type: 'any' }],
    outputs: out('result', 'Result', outType),
    compile: { expr: (c) => ({ code: `${fn}(${c.arg('value')})`, prec: c.P.ATOM }) },
  });
  convert('convert.str', 'To Text', 'str', 'string', 'Turns any value into text.', 'string str text convert 문자열 변환');
  convert('convert.int', 'To Integer', 'int', 'int', 'Turns text or a number into a whole number.', 'int integer whole convert 정수 변환');
  convert('convert.float', 'To Number', 'float', 'number', 'Turns text into a number that may have a decimal point.', 'float decimal number convert 실수 숫자 변환');
  reg({
    type: 'text.format', category: 'Text', title: 'Format Text',
    description: 'Fills the {names} in a template with values, like "Hello {name}".',
    keywords: 'format template f-string placeholder 서식 템플릿 형식',
    props: [{ id: 'template', label: 'Template', kind: 'string', default: 'Hello {name}' }],
    outputs: out('text', 'Text', 'string'),
    pins: (node) => ({
      inputs: VS.templateFields(VS.propOf(node, 'template')).fields.map((f) => ({ id: f, label: f, type: 'any' })),
    }),
    compile: { expr: (c) => c.formatText(c.prop('template')) },
  });

  // ---------- Input/Output ----------
  reg({
    type: 'io.print', category: 'Input/Output', title: 'Print',
    description: 'Shows a value in the Run window.',
    keywords: 'print output show write console 출력 표시 프린트',
    exec: EXEC,
    inputs: [{ id: 'value', label: 'Value', type: 'any', default: 'Hello' }],
    compile: {
      stmt(c) {
        const v = c.input('value');
        c.line(!c.linked('value') && v.value === '' ? 'print()' : `print(${c.arg('value')})`);
        return 'next';
      },
    },
  });
  reg({
    type: 'io.input', category: 'Input/Output', title: 'Ask User',
    description: 'Shows a question in the Run window and waits for the user to type an answer.',
    keywords: 'input ask read keyboard question 입력 질문 묻기',
    exec: EXEC,
    inputs: [{ id: 'prompt', label: 'Question', type: 'string', default: '' }],
    outputs: out('answer', 'Answer', 'string'),
    compile: {
      stmt(c) {
        const call = !c.linked('prompt') && c.input('prompt').value === '' ? 'input()' : `input(${c.arg('prompt')})`;
        c.line(c.used('answer') ? `${c.local('answer')} = ${call}` : call);
        return 'next';
      },
    },
  });

  // ---------- Lists ----------
  reg({
    type: 'list.append', category: 'Lists', title: 'Append',
    description: 'Adds an item to the end of a list.',
    keywords: 'append add push list 추가 목록 리스트',
    exec: EXEC,
    inputs: [{ id: 'list', label: 'List', type: 'list' }, { id: 'item', label: 'Item', type: 'any' }],
    compile: {
      stmt(c) {
        const list = c.arg('list', c.P.ATOM);
        c.line(`${/^\d+$/.test(list) ? `(${list})` : list}.append(${c.arg('item')})`);
        return 'next';
      },
    },
  });
  reg({
    type: 'list.len', category: 'Lists', title: 'Length',
    description: 'How many items a list (or letters a text) has.',
    keywords: 'len length count size 길이 개수 크기',
    inputs: [{ id: 'list', label: 'List', type: 'any' }],
    outputs: out('length', 'Length', 'int'),
    compile: { expr: (c) => ({ code: `len(${c.arg('list')})`, prec: c.P.ATOM }) },
  });
  reg({
    type: 'list.get', category: 'Lists', title: 'Get Item',
    description: 'Gets the item at a position. The first item is at 0.',
    keywords: 'index item get at element 항목 가져오기 인덱스',
    inputs: [{ id: 'list', label: 'List', type: 'any' }, { id: 'index', label: 'Index', type: 'number', default: 0 }],
    outputs: out('item', 'Item', 'any'),
    compile: { expr: (c) => ({ code: `${c.arg('list', c.P.ATOM)}[${c.arg('index')}]`, prec: c.P.ATOM }) },
  });

  // ---------- Functions ----------
  reg({
    type: 'fn.define', category: 'Functions', title: 'Define Function',
    description: 'Starts a function: steps you can run again with Call Function. Its parameters become outputs.',
    keywords: 'function def define procedure 함수 정의',
    exec: { in: false, out: [{ id: 'body', label: 'Body' }] },
    props: [
      { id: 'name', label: 'Name', kind: 'identifier', default: 'my_function' },
      { id: 'params', label: 'Parameters', kind: 'string', default: '', placeholder: 'a, b' },
    ],
    subtitle: (p) => p.name,
    pins: (node) => ({ outputs: VS.parseNames(VS.propOf(node, 'params')).map((p) => ({ id: p, label: p, type: 'any' })) }),
    compile: {
      entry(c) {
        const params = VS.parseNames(c.prop('params')).map((p) => c.identValue(p, 'params'));
        c.line(`def ${c.ident('name')}(${params.join(', ')}):`);
        c.block('body', { fn: true });
      },
      output: (c, pin) => ({ code: c.identValue(pin, 'params'), prec: c.P.ATOM }),
    },
  });
  reg({
    type: 'fn.return', category: 'Functions', title: 'Return',
    description: 'Ends the function and gives its result back to Call Function.',
    keywords: 'return result give back 반환 돌려주기 결과',
    exec: { in: true, out: [] },
    inputs: [{ id: 'value', label: 'Value', type: 'any', optional: true }],
    compile: {
      stmt(c) {
        if (!c.inFunction) return c.fail(c.tr('Return can only be used inside a Define Function.'));
        c.line(c.linked('value') || c.input('value').value !== undefined ? `return ${c.arg('value', -1)}` : 'return');
        return null;
      },
    },
  });
  reg({
    type: 'fn.call', category: 'Functions', title: 'Call Function',
    description: 'Runs a function made with Define Function and gives its result.',
    keywords: 'call function run invoke 함수 호출 실행',
    exec: EXEC,
    props: [{ id: 'function', label: 'Function', kind: 'identifier', default: '', suggest: 'functions' }],
    outputs: out('result', 'Result', 'any'),
    subtitle: (p) => p.function,
    pins: (node, graph) => {
      const fn = VS.findFunction(graph, VS.propOf(node, 'function'));
      const params = fn ? VS.parseNames(VS.propOf(fn, 'params')) : [];
      return { inputs: params.map((p) => ({ id: p, label: p, type: 'any' })) };
    },
    compile: {
      stmt(c) {
        const name = c.prop('function');
        if (!c.functionExists(name)) {
          return c.fail(name
            ? c.tr('There is no Define Function named "{name}".', { name })
            : c.tr('Choose the function to call.'), 'function');
        }
        const call = `${c.ident('function')}(${c.pins.inputs.map((p) => c.arg(p.id)).join(', ')})`;
        c.line(c.used('result') ? `${c.local('result')} = ${call}` : call);
        return 'next';
      },
    },
  });

  // ---------- Python ----------
  reg({
    type: 'py.call', category: 'Python', title: 'Call Python',
    description: 'Calls any Python function, for example sqrt from the math module.',
    keywords: 'python call module function library import 파이썬 호출 모듈 라이브러리',
    exec: EXEC,
    props: [
      { id: 'module', label: 'Module', kind: 'string', default: 'math', placeholder: 'math' },
      { id: 'function', label: 'Function', kind: 'string', default: 'sqrt', placeholder: 'sqrt' },
      { id: 'count', label: 'Number of arguments', kind: 'number', default: 1, min: 0, max: 32 },
    ],
    outputs: out('result', 'Result', 'any'),
    subtitle: (p) => (p.module ? `${p.module}.${p.function}` : p.function),
    pins: (node) => ({
      inputs: Array.from({ length: count(node, 'count') }, (_, i) => ({ id: `arg${i}`, label: tr('Argument {n}', { n: i + 1 }), type: 'any' })),
    }),
    compile: {
      stmt(c) {
        const module = String(c.prop('module') || '').trim();
        const fn = String(c.prop('function') || '').trim();
        if (module && !c.dotted(module)) return c.fail(c.tr('"{name}" is not a valid module name.', { name: module }), 'module');
        if (!c.dotted(fn)) {
          return c.fail(fn ? c.tr('"{name}" is not a valid function name.', { name: fn }) : c.tr('Enter the name of the function to call.'), 'function');
        }
        if (module) c.import(module);
        const call = `${module ? `${module}.` : ''}${fn}(${c.pins.inputs.map((p) => c.arg(p.id)).join(', ')})`;
        c.line(c.used('result') ? `${c.local('result')} = ${call}` : call);
        return 'next';
      },
    },
  });
  const namedPins = (node, key) => VS.parseNames(VS.propOf(node, key)).map((p) => ({ id: p, label: p, type: 'any' }));
  reg({
    type: 'py.expr', category: 'Python', title: 'Python Expression',
    description: 'Computes a Python expression. Its inputs are available under the names you list.',
    keywords: 'python expression code formula 파이썬 식 표현식 수식',
    props: [
      { id: 'code', label: 'Expression', kind: 'code', default: 'x * 2' },
      { id: 'inputs', label: 'Input names', kind: 'string', default: 'x', placeholder: 'x, y' },
    ],
    outputs: out('result', 'Result', 'any'),
    pins: (node) => ({ inputs: namedPins(node, 'inputs') }),
    compile: { expr: (c) => c.pythonExpression(c.prop('code'), VS.parseNames(c.prop('inputs'))) },
  });
  reg({
    type: 'py.code', category: 'Python', title: 'Python Code',
    description: 'Runs lines of Python you write. Inputs are set as variables first; list the variables it sets as outputs.',
    keywords: 'python code script statements 파이썬 코드 스크립트',
    exec: EXEC,
    props: [
      { id: 'code', label: 'Code', kind: 'code', default: 'print(x)' },
      { id: 'inputs', label: 'Input names', kind: 'string', default: 'x', placeholder: 'x, y' },
      { id: 'outputs', label: 'Output names', kind: 'string', default: '', placeholder: 'result' },
    ],
    pins: (node) => ({ inputs: namedPins(node, 'inputs'), outputs: namedPins(node, 'outputs') }),
    compile: {
      stmt(c) {
        for (const p of c.pins.inputs) c.line(`${c.identValue(p.id, 'inputs')} = ${c.arg(p.id, -1)}`);
        const lines = c.dedent(c.prop('code'));
        if (!lines.length && !c.pins.inputs.length) c.line('pass');
        for (const l of lines) c.line(l);
        return 'next';
      },
      output: (c, pin) => ({ code: c.identValue(pin, 'outputs'), prec: c.P.ATOM }),
    },
  });

  // ---------- Other ----------
  reg({
    type: 'ui.comment', category: 'Other', title: 'Comment',
    description: 'A note on the canvas. It does not run.',
    keywords: 'comment note memo 주석 메모 설명',
    props: [{ id: 'text', label: 'Text', kind: 'code', default: 'Comment' }],
    comment: true,
  });

  if (typeof module === 'object' && module.exports) module.exports = VS;
})(typeof window !== 'undefined' ? window : globalThis);
