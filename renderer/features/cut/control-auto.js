// The control API's tools for automation (docs/cut-ai-control.md): the Automation menu's jobs (speech recognition, auto
// captions, filler words, speaker labels, voice isolation, scene changes, beats, loudness, ducking, auto color) as one
// tool with an action, Essential Sound's one-click effects, and the speaker labels. A job runs in the page
// (services.automation, ui-control.js) with the progress box the menu shows, reports its progress to the chat and
// ends when the user presses Stop. A job that needs a model asks the user in Cut's setup dialog first; nothing is
// downloaded without it.
(function (part) {
  if (typeof module === 'object' && module.exports) module.exports = part;
  else globalThis.Cut.control.extend(part);
})((K) => {
  const { tool, refuse, need, M, C, num, int, str, bool, ids, obj, bare, context, clipOf, kindOf, timeIn, run } = K;

  // action -> the arguments it takes (besides action) and what a refusal of its setup names.
  const JOBS = {
    transcribe: { args: ['clip_ids', 'from', 'to', 'language'], model: 'speech recognition (Whisper)' },
    auto_captions: { args: ['clip_ids', 'from', 'to', 'language', 'chars_per_line', 'highlight'], model: 'speech recognition (Whisper)' },
    remove_fillers: { args: ['clip_ids', 'from', 'to', 'fillers', 'pauses', 'pause_length', 'keep'], model: 'speech recognition (Whisper)' },
    label_speakers: { args: ['speakers'], model: 'speaker labels (WeSpeaker)' },
    isolate_voice: { args: ['clip_ids'], model: 'voice isolation (HTDemucs)' },
    detect_scenes: { args: ['clip_ids', 'threshold', 'mode'] },
    detect_beats: { args: ['clip_ids', 'every'] },
    match_loudness: { args: ['target'] },
    match_clip_loudness: { args: ['clip_ids', 'target'] },
    auto_duck: { args: ['amount', 'fade', 'threshold'] },
    auto_color: { args: ['clip_ids', 'time'] },
  };
  // the chat's step line of each job (translated in the panel)
  const JOB_STEPS = {
    transcribe: 'Recognize speech', auto_captions: 'Create auto captions', remove_fillers: 'Remove filler words', label_speakers: 'Label speakers', isolate_voice: 'Isolate the voice',
    detect_scenes: 'Detect scene changes', detect_beats: 'Detect beats', match_loudness: 'Match loudness', match_clip_loudness: 'Match clip loudness', auto_duck: 'Auto ducking', auto_color: 'Auto color',
  };
  const ARGS = {
    clip_ids: ids('The clips (default: the selection, else every clip it fits, as the menu does).'),
    from: num('With to: only this range of the timeline (s), as In/Out.', { minimum: 0 }), to: num('End of the range (s).', { minimum: 0 }),
    language: str('auto (default), ko or en.', { enum: ['auto', 'ko', 'en'] }), chars_per_line: int('0: 18 for Korean, 42 otherwise.', { minimum: 0, maximum: 80 }),
    highlight: bool('Light each word as it is spoken.'), fillers: bool('Filler words (default true).'), pauses: bool('Long pauses (default true).'),
    pause_length: num('Pauses longer than (s), 0.3..10.', { minimum: 0.3, maximum: 10 }), keep: num('Kept on each side (s), 0..1.', { minimum: 0, maximum: 1 }),
    speakers: int('How many speakers (0: find out).', { minimum: 0, maximum: 10 }),
    threshold: num('detect_scenes: % of change, 5..95 (default 35); auto_duck: speech louder than (dB, -90..-5).', { minimum: -90, maximum: 95 }),
    mode: str('markers (default) or split.', { enum: ['markers', 'split'] }), every: str('beat (default) or bar.', { enum: ['beat', 'bar'] }),
    target: num('LUFS, -40..-5 (YouTube -14, podcasts -16, broadcast -24).', { minimum: -40, maximum: -5 }),
    amount: num('dB, -40..-1 (default -12).', { minimum: -40, maximum: -1 }), fade: num('s, 0..2 (default 0.3).', { minimum: 0, maximum: 2 }),
    time: num('The frame to analyze (s; default five frames across the clip).', { minimum: 0 }),
  };
  tool('automation', 'edit', 'Automation',
    'Runs an Automation menu job on this PC as one undo step; it reports progress and ends on Stop. transcribe (speech recognition; get_transcript reads it), auto_captions (a caption track from it), remove_fillers (ripple-deletes filler words and long pauses), label_speakers, isolate_voice (the voice without music or noise), detect_scenes (markers or splits), detect_beats (beat markers of an audio clip), match_loudness (master gain for a LUFS target), match_clip_loudness (each clip\'s volume for it), auto_duck (music lowered under dialogue; set_clip role first), auto_color (white balance and exposure). A job that needs a model asks the user in Cut\'s setup dialog first; a no is a refusal.',
    obj({ action: str('The job.', { enum: Object.keys(JOBS) }), ...ARGS }, ['action']),
    async (c, a) => {
      const job = JOBS[a.action];
      for (const k of Object.keys(ARGS)) if (a[k] !== undefined && !job.args.includes(k)) refuse(`${a.action} takes ${job.args.join(', ') || 'no other arguments'}; not ${k}.`);
      if ((a.from == null) !== (a.to == null)) refuse('Give from and to together.');
      const range = a.from != null ? [timeIn(c, a.from, 'from'), timeIn(c, a.to, 'to')] : null;
      if (range && range[1] - range[0] < c.f) refuse('"to" must be after "from".');
      if (a.action === 'detect_scenes' && a.threshold != null && a.threshold < 5) refuse('threshold of detect_scenes is 5..95 (%).');
      if (a.action === 'auto_duck' && a.threshold != null && a.threshold > -5) refuse('threshold of auto_duck is -90..-5 (dB).');
      const clips = (a.clip_ids || []).map((id) => clipOf(c, id));
      const sound = (x) => kindOf(c, x) === 'audio' || M().linkedClips(c.seq, x).some((l) => kindOf(c, l) === 'audio');
      const picture = (x) => kindOf(c, x) === 'video' && !x.source?.generator && x.source?.media != null;
      const need2 = { isolate_voice: [sound, 'a clip with sound'], detect_beats: [sound, 'an audio clip'], match_clip_loudness: [sound, 'a clip with sound'], detect_scenes: [picture, 'a video clip of a media file'], auto_color: [picture, 'a video clip of a media file'] }[a.action];
      if (need2) for (const x of clips) if (!need2[0](x)) refuse(`${x.id} is not ${need2[1]}.`);
      if (a.action === 'auto_color' && clips.length > 1) refuse('auto_color works on one clip at a time.');
      if (a.action === 'auto_color' && a.time != null) {
        const t = timeIn(c, a.time, 'time');
        const x = clips[0];
        if (x && (t < x.start || t >= M().clipEnd(x))) refuse(`time ${a.time} s is outside ${x.id}.`);
      }
      if (!c.services?.automation) refuse('Automation is not available here.');
      const r = await c.services.automation(a.action, { ...a, range, clipIds: a.clip_ids || null }, { seq: c.seq, signal: c.signal, progress: c.progress });
      if (r?.declined) refuse(`The user did not agree to set up ${job.model} in Cut's setup dialog, so nothing was downloaded or changed. Tell them it is needed and that they can download it when Cut asks.`);
      if (r?.cancelled) refuse(`${a.action} was stopped. Nothing was changed.`);
      if (!r?.ok) refuse(r?.error || `${a.action} changed nothing.`);
      return { ...(r.changed ? { edit: { at: r.at ?? c.app.t, ...(r.seqId ? { seqId: r.seqId } : {}) } } : {}), ...r.value };
    }, (a) => [JOB_STEPS[a.action], {}]);

  // ---------- Essential Sound ----------
  const ESSENTIAL = { clarity: 'clarity', reduce_hum_50: 'hum50', reduce_hum_60: 'hum60', noise_gate: 'gate', hard_limiter: 'limit' };
  const ESSENTIAL_STEPS = { clarity: 'Clarity on {n} clips', reduce_hum_50: 'Reduce hum on {n} clips', reduce_hum_60: 'Reduce hum on {n} clips', noise_gate: 'Noise gate on {n} clips', hard_limiter: 'Hard limiter on {n} clips' };
  tool('essential_sound', 'edit', 'Essential Sound',
    'Essential Sound\'s one-click repairs on audio clips (a video clip brings its linked audio): clarity (EQ and compressor for dialogue), reduce_hum_50 or reduce_hum_60 (mains hum), noise_gate, hard_limiter (-1 dB). Each adds its effects with the panel\'s settings, as one undo step; set_effect changes them after. The audio type is set_clip role; voice isolation, ducking and loudness are automation jobs.',
    obj({ clip_ids: ids('The clips.'), action: str('The repair.', { enum: Object.keys(ESSENTIAL) }) }, ['clip_ids', 'action']),
    (c, a) => {
      const out = new Set();
      for (const id of a.clip_ids) {
        const x = clipOf(c, id);
        const audio = [x, ...M().linkedClips(c.seq, x)].filter((y) => kindOf(c, y) === 'audio');
        if (!audio.length) refuse(`${x.id} has no sound.`);
        for (const y of audio) out.add(clipOf(c, y.id));
      }
      const preset = need('audiofx').ESSENTIAL[ESSENTIAL[a.action]];
      const cmds = [...out].flatMap((x) => preset.map(([type, params]) => C().addEffect(c.seq.id, x.id, type, null, params)));
      run(c, C().batch({ clarity: 'Clarity', reduce_hum_50: 'Reduce Hum', reduce_hum_60: 'Reduce Hum', noise_gate: 'Noise Gate', hard_limiter: 'Hard Limiter' }[a.action], cmds));
      return { edit: { at: Math.min(...[...out].map((x) => x.start)) }, clips: [...out].map((x) => x.id), effects: preset.map(([type]) => type) };
    }, (a) => [ESSENTIAL_STEPS[a.action], { n: a.clip_ids.length }]);

  // ---------- speakers ----------
  tool('speakers', 'edit', 'Speakers',
    'The speaker labels of the project (made by automation label_speakers): list them (id, name, color), or rename one (speaker_id, name; an empty name goes back to "Speaker n"). Names show in the Transcript panel and in captions that show speakers.',
    bare({ action: str('list (default) or rename.', { enum: ['list', 'rename'] }), speaker_id: str('The speaker.', { maxLength: 32 }), name: str('The new name.', { maxLength: 60 }) }),
    (c0, a) => {
      const c = context(c0);
      const sp = c.project.speakers;
      const list = () => (c.project.speakers?.list || []).map((s, i) => ({ id: s.id, name: s.name || `Speaker ${i + 1}`, color: s.color }));
      if ((a.action || 'list') === 'list') {
        if (a.speaker_id !== undefined || a.name !== undefined) refuse('list takes nothing else.');
        return { speakers: list(), ...(sp ? {} : { note: 'There are no speaker labels yet (automation label_speakers makes them).' }) };
      }
      if (!sp?.list?.length) refuse('There are no speaker labels yet; run automation label_speakers first.');
      if (a.speaker_id == null || a.name == null) refuse('rename needs speaker_id and name.');
      if (!sp.list.some((s) => s.id === a.speaker_id)) refuse(`There is no speaker ${a.speaker_id}. Speakers: ${sp.list.map((s) => s.id).join(', ')}.`);
      const name = a.name.replace(/\s+/g, ' ').trim();
      run(c, C().batch('Rename Speaker', [C().setSpeakers({ list: sp.list.map((s) => (s.id === a.speaker_id ? { ...s, name } : s)) })]));
      return { edit: { at: c.app.t }, speakers: list() };
    }, (a) => [a.action === 'rename' ? 'Rename speaker {id}' : 'Read the speakers', { id: a.speaker_id || '' }]);
});
