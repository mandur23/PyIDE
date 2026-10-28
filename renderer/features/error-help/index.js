// An "Explain" button before the exception name on the last line of a Python traceback, in every console (Run, Debug,
// Python Console, tests). It opens what the error means, its usual causes and fixes, hints read from the message
// (a None from a search, text plus a number, an encoding), where it was raised (the last frame in the project), and
// "Ask AI", which opens that file and sends the traceback to AI Chat. Runtime messages come from Python in English;
// the explanations are the IDE's own, so they read in the IDE's language.
(() => {
  const { el, basename, isUnder } = ide.util;

  // What each built-in exception means and what usually fixes it.
  const ERRORS = {
    SyntaxError: [() => tr('Python could not read the code: a line is written in a way Python does not allow, so nothing ran.'), () => [
      tr("Look at the line shown and the one just before it: a missing ':', bracket or quote is the usual cause."),
      tr('Check that brackets and quotes opened on earlier lines are closed.')]],
    IndentationError: [() => tr('The indentation (the spaces at the start of lines) does not match the structure of the code.'), () => [
      tr("After a line ending in ':', indent the next line by 4 spaces."),
      tr('Start the lines of one block at the same column.')]],
    TabError: [() => tr('Tabs and spaces are mixed in the indentation.'), () => [tr('Use only spaces, 4 per level; Code › Reformat Code fixes the file.')]],
    NameError: [() => tr('A name is used that is not defined here, or is spelled differently.'), () => [
      tr('Check the spelling and the capital letters of the name.'),
      tr('Define the variable, or import the module, before this line.'),
      tr('A variable created inside a function exists only in that function.')]],
    UnboundLocalError: [() => tr('A variable is read inside a function before the function assigned it a value.'), () => [
      tr('Assign the variable before using it.'),
      tr("To change a module-level variable inside a function, declare it with 'global'.")]],
    TypeError: [() => tr('An operation or call got a value of the wrong type, or a function got the wrong number of arguments.'), () => [
      tr('Print the values, or stop there with the debugger, to see their types.'),
      tr('Convert values explicitly, for example str(n) or int(text).'),
      tr("Check the function's parameters: Ctrl+P in the call shows them.")]],
    ValueError: [() => tr("The value has the right type but content that cannot be used, for example int('abc')."), () => [
      tr('Check the input before converting it, or catch ValueError with try/except.')]],
    AttributeError: [() => tr('The object has no attribute or method with that name.'), () => [
      tr('Check the spelling.'),
      tr('Check the type of the object: None from a function that returned nothing is a common cause.'),
      tr('Ctrl+Space after the dot in the editor lists the attributes that exist.')]],
    KeyError: [() => tr('The dictionary has no item with that key.'), () => [
      tr('Use d.get(key) or d.get(key, default) when the key may be missing.'),
      tr("Check 'key in d' first, and the key's spelling and type: '1' and 1 are different keys.")]],
    IndexError: [() => tr('The index is outside the list or string; the last index is len() - 1.'), () => [
      tr('Check the length with len() before indexing.'),
      tr('Loop over the items themselves (for item in items) instead of their indexes.')]],
    ZeroDivisionError: [() => tr('A number was divided by zero.'), () => [tr('Check that the divisor is not 0 before dividing.')]],
    ModuleNotFoundError: [() => tr('The module is not installed in the interpreter that ran the program, or its name is misspelled.'), () => [
      tr("Click 'Install package' next to the message, or install it in Python Packages."),
      tr("Check that the program ran with the project's interpreter (bottom right of the status bar).")]],
    ImportError: [() => tr('The module was found, but the name imported from it is not there, or the module failed to load.'), () => [
      tr("Check the spelling and the package's version: the name may have moved or been renamed."),
      tr('A file of yours named like the module (random.py, for example) hides the real one.')]],
    FileNotFoundError: [() => tr('No file or folder exists at that path.'), () => [
      tr("A relative path starts from the working directory, the run configuration's (usually the project folder)."),
      tr("Build paths from the script's folder: Path(__file__).parent / 'data.txt'.")]],
    PermissionError: [() => tr('The program is not allowed to open or change the file.'), () => [
      tr('Close the file in other programs (Excel, for example).'),
      tr('Write to a folder you own, such as the project folder.')]],
    IsADirectoryError: [() => tr('A folder was opened as if it were a file.'), () => [tr('Check the path: it should name a file inside the folder.')]],
    UnicodeDecodeError: [() => tr('A file or text was read with the wrong text encoding.'), () => [
      tr("Pass the encoding: open(path, encoding='utf-8'), or encoding='cp949' for files saved by Korean Windows programs.")]],
    UnicodeEncodeError: [() => tr('Text could not be written in the target encoding.'), () => [tr("Open the file with encoding='utf-8'.")]],
    RecursionError: [() => tr('A function called itself too many times, probably without ever stopping.'), () => [tr('Check the condition that ends the recursion.')]],
    StopIteration: [() => tr('next() was called on an iterator that has no items left.'), () => [tr('Pass a default, next(it, None), or use a for loop.')]],
    AssertionError: [() => tr("An assert statement's condition was false."), () => [tr('Look at the condition of the assert and the values it checks.')]],
    KeyboardInterrupt: [() => tr('The program was stopped (Stop or Ctrl+C).'), () => []],
    RuntimeError: [() => tr('A general error for when nothing more specific fits; the message says what went wrong.'), () => []],
    NotImplementedError: [() => tr('A method that a subclass has to define was called.'), () => [tr('Define the method in your subclass.')]],
    OverflowError: [() => tr('A number became too large to represent.'), () => []],
    MemoryError: [() => tr('The program ran out of memory.'), () => [tr('Process the data in parts instead of loading all of it at once.')]],
    JSONDecodeError: [() => tr('The text is not valid JSON: often an empty response, or an HTML page instead of JSON.'), () => [
      tr('Print the text before parsing it.'),
      tr('For a web response, check its status code first.')]],
    ConnectionError: [() => tr('No connection could be made to the server.'), () => [
      tr('Check that the server is running and that the address and port are right.'),
      tr('Check the internet connection and the firewall.')]],
    ConnectionRefusedError: [() => tr('The computer at that address refused the connection: nothing listens on that port.'), () => [
      tr('Check that the server is running and that the address and port are right.')]],
    TimeoutError: [() => tr('An operation took longer than allowed.'), () => [tr('Check the network, or allow a longer timeout.')]],
    OSError: [() => tr('The operating system refused a file or network operation; the message gives the reason.'), () => []],
  };
  // Hints read from the message, whatever the exception's type.
  const HINTS = [
    [/'NoneType' object|of type 'NoneType'|attribute of "None"/, () => tr("A value is None: a function returned nothing, or a search (find(), get(), re.match()) found nothing. Check it with 'if x is not None:' first.")],
    [/can only concatenate str|unsupported operand type\(s\) for \+: '(int|float)' and 'str'|'str' and '(int|float)'/, () => tr("Text and a number were combined: convert with str(n), or use an f-string such as f'{name} {n}'.")],
    [/takes \d+ positional arguments? but \d+ (were|was) given/, () => tr('The call passes more arguments than the function takes; a method also receives self.')],
    [/missing \d+ required positional argument/, () => tr('The call leaves out an argument the function needs.')],
    [/object is not callable/, () => tr('Parentheses follow something that is not a function, or a variable has the same name as a function.')],
    [/invalid literal for int\(\)|could not convert string to float/, () => tr('The text is not a number: remove spaces with .strip(), or check the input first.')],
    [/was never closed|unterminated (triple-quoted )?string literal|EOL while scanning/, () => tr('A bracket or a quote is not closed.')],
  ];

  const LINE = /(?<=^|\n)((?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*(?:Error|Exception|Warning|Exit|Interrupt|Iteration)))(?=: |:\r?$|:\r?\n|\r?\n|$)/g;
  const FRAME = /File "([^"<][^"]*)", line (\d+)/g;

  // The traceback that ends at the exception line `a` is on: from the last "Traceback" header before it (or the
  // lines just before it), to the end of that line.
  function tracebackOf(a) {
    const out = a.closest('.console');
    const before = document.createRange();
    before.setStart(out, 0);
    before.setEndBefore(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.setEnd(out, out.childNodes.length);
    const head = before.toString();
    const start = head.lastIndexOf('Traceback (most recent call last):');
    const lead = start >= 0 ? head.slice(start) : head.split('\n').slice(-12).join('\n');
    const line = a.textContent + after.toString().split('\n')[0];
    return { text: `${lead}${line}`.replace(/\r/g, '').trim(), message: line.slice(a.textContent.length).replace(/^:\s*/, '').trim() };
  }
  // The frame to show: the last one in the project, else the last one.
  function placeOf(text) {
    const frames = [...text.matchAll(FRAME)].map((m) => ({ path: ide.toLocalPath(m[1]), line: Number(m[2]) }));
    return [...frames].reverse().find((f) => ide.root && isUnder(f.path, ide.root)) || frames[frames.length - 1] || null;
  }

  function explain(name, a) {
    const { text, message } = tracebackOf(a);
    const place = placeOf(text);
    const short = name.split('.').pop();
    const known = ERRORS[short];
    const body = el('div', 'error-help');
    const msg = el('pre', 'error-help-message', `${name}${message ? `: ${message}` : ''}`);
    msg.dataset.userText = '';
    body.append(msg);
    body.append(el('h4', null, tr('What it means')));
    const module = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '__main__';
    body.append(el('p', null, known ? known[0]() : tr('This error comes from {module}, not from Python itself. The message says what went wrong; Ask AI can explain it with your code.', { module: module === '__main__' ? tr('a library or your code') : module })));
    const tips = [...HINTS.filter(([re]) => re.test(message)).map(([, t]) => t()), ...(known ? known[1]() : [])];
    if (tips.length) {
      body.append(el('h4', null, tr('How to fix it')));
      const ul = el('ul');
      for (const t of tips) ul.append(el('li', null, t));
      body.append(ul);
    }
    if (place) {
      const where = el('p', 'error-help-place');
      const link = el('a', null, tr('{file}, line {line}', { file: basename(place.path), line: place.line }));
      link.dataset.userText = '';
      link.onclick = () => { dlg.close(); ide.openFile(place.path, { line: place.line }); };
      where.append(el('span', 'muted', tr('Raised at') + ' '), link);
      body.append(where);
    }
    const buttons = [];
    if (ide.aiChat) {
      buttons.push({ label: tr('Ask AI'), primary: true, run: async () => {
        if (place) await ide.openFile(place.path, { line: place.line });
        ide.aiChat.open();
        ide.aiChat.send(tr('Running the program stopped with this error. Explain the cause in simple terms and show how to fix the code.') + `\n\n\`\`\`\n${text}\n\`\`\``);
      } });
    }
    if (place) buttons.push({ label: tr('Go to Error'), primary: !ide.aiChat, run: () => ide.openFile(place.path, { line: place.line }) });
    buttons.push({ label: tr('Close') });
    const dlg = ide.ui.dialog({ title: short, body, buttons, width: 600 });
    dlg.el.id = 'errorHelp';
    return dlg;
  }

  ide.ui.addConsoleLink(LINE, (m) => {
    const a = document.createElement('a');
    a.className = 'error-help-link';
    a.textContent = m[1];
    a.title = a.dataset.explain = tr('Explain');
    a.onclick = () => explain(m[1], a);
    return a;
  });

  ide.errorHelp = { explain, known: () => Object.keys(ERRORS) };
})();
