/**
 * BM Sender — еженедельные отчёты родителям (Google Apps Script версия).
 *
 * Привязан к гугл-таблице участников (Extensions > Apps Script внутри неё).
 * Делает то же самое, что и Python-пайплайн в d:\BM\Sender:
 *   таблица участников -> Fireflies (полный транскрипт) -> Claude API
 *   (пишет отчёт по стилю CLAUDE.md) -> Telegram.
 *
 * Настройка — см. README.md рядом с этим файлом.
 */

// ===== Конфигурация =====

function getConfig_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    firefliesApiKey: p.getProperty('FIREFLIES_API_KEY'),
    telegramBotToken: p.getProperty('TELEGRAM_BOT_TOKEN'),
    telegramChatId: p.getProperty('TELEGRAM_CHAT_ID'),
    anthropicApiKey: p.getProperty('ANTHROPIC_API_KEY'),
  };
  for (var key in cfg) {
    if (!cfg[key]) {
      throw new Error('Не задан Script Property: ' + key + '. Project Settings -> Script Properties.');
    }
  }
  return cfg;
}

// ===== Ростер (читаем прямо из таблицы, к которой привязан скрипт) =====

function getRoster_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var rows = sheet.getDataRange().getValues();
  var roster = [];
  for (var i = 0; i < rows.length; i++) {
    var fio = String(rows[i][0] || '').trim();
    var parents = String(rows[i][1] || '').trim();
    var messenger = String(rows[i][2] || '').trim();
    if (!fio) continue;
    roster.push({ fio: fio, parents: parents, messenger: messenger });
  }
  return roster;
}

// ===== Fireflies =====

var FIREFLIES_URL = 'https://api.fireflies.ai/graphql';
var FIREFLIES_PAGE_SIZE = 50;

function firefliesRequest_(query, variables) {
  var cfg = getConfig_();
  var resp = UrlFetchApp.fetch(FIREFLIES_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.firefliesApiKey },
    payload: JSON.stringify({ query: query, variables: variables }),
    muteHttpExceptions: true,
  });
  var payload = JSON.parse(resp.getContentText());
  if (payload.errors && payload.errors.length) {
    throw new Error('Fireflies API error: ' + JSON.stringify(payload.errors));
  }
  return payload.data;
}

var TRANSCRIPTS_QUERY = [
  'query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {',
  '  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {',
  '    id title date',
  '  }',
  '}',
].join('\n');

function isoDate_(d) {
  return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.000'Z'");
}

function getTranscriptsList_(fromDate, toDate) {
  var all = [];
  var skip = 0;
  while (true) {
    var data = firefliesRequest_(TRANSCRIPTS_QUERY, {
      fromDate: isoDate_(fromDate),
      toDate: isoDate_(toDate),
      limit: FIREFLIES_PAGE_SIZE,
      skip: skip,
    });
    var page = data.transcripts || [];
    all = all.concat(page);
    if (page.length < FIREFLIES_PAGE_SIZE) break;
    skip += FIREFLIES_PAGE_SIZE;
  }
  return all;
}

function findMeetingsFor_(fio, allMeetings) {
  var parts = fio.split(/\s+/).filter(function (p) { return p.length > 0; });
  return allMeetings.filter(function (m) {
    var title = m.title || '';
    return parts.every(function (p) {
      return title.toLowerCase().indexOf(p.toLowerCase()) !== -1;
    });
  });
}

var TRANSCRIPT_QUERY = [
  'query Transcript($id: String!) {',
  '  transcript(id: $id) {',
  '    id title',
  '    sentences { speaker_name text start_time }',
  '  }',
  '}',
].join('\n');

function formatTime_(seconds) {
  seconds = Math.floor(seconds || 0);
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

function getFullTranscript_(meetingId) {
  var data = firefliesRequest_(TRANSCRIPT_QUERY, { id: meetingId });
  var sentences = (data.transcript && data.transcript.sentences) || [];
  return sentences
    .map(function (s) {
      return '[' + formatTime_(s.start_time) + '] ' + (s.speaker_name || 'Speaker') + ': ' + (s.text || '');
    })
    .join('\n');
}

// ===== Claude (Anthropic API) — пишет текст отчёта по стилю CLAUDE.md =====

var STYLE_GUIDE = [
  'Ты пишешь еженедельное касание для родителей участника программы развития BizMission.',
  'Используй ТОЛЬКО информацию из предоставленного транскрипта встречи. Ничего не додумывай.',
  '',
  'Касание — не пересказ встречи и не конспект занятия. Оно должно за 1-2 минуты дать',
  'родителю ответ на 4 вопроса: что произошло -> что сделал/сформировал участник ->',
  'какой навык/результат развивается -> какой следующий шаг согласован.',
  '',
  'Обязательно:',
  '- отделяй уже выполненное от запланированного (не выдавай план за факт);',
  '- не указывай неподтверждённые даты и договорённости;',
  '- не превращай гипотезы в факты, не усиливай формулировки без оснований',
  '  ("может дать скидку" -> "можно будет учитывать");',
  '- не включай информацию, которую родители уже знают (результаты экзаменов/оценки,',
  '  которые они и так получили; содержание встречи, на которой сами присутствовали —',
  '  для неё максимум одна фраза);',
  '- не пересказывай встречу последовательно (список тем) — забирай только смысл;',
  '- не включай бытовые детали (еда, Wi-Fi, покупки, шутки, повседневные планы);',
  '- НЕ передавай личные признания участника, критику родителей, сравнение поддержки',
  '  родителей и друзей, семейные конфликты, национальные/личные антипатии — даже если',
  '  это прозвучало на встрече, это нарушение доверия;',
  '- не придумывай оценки личности и характеристики ("методично вникает", "самостоятельное',
  '  мышление"), если это не подтверждено конкретным наблюдением;',
  '- не создавай искусственную похвалу ("хорошая новость", "отлично справился");',
  '- не перегружай текст названиями методик (GROW/SMART/ICF) и теорией — только факт и стадия;',
  '- показывай действия САМОГО УЧАСТНИКА, а не только куратора ("Соня разобрала...", а не',
  '  "куратор рассказал...");',
  '- объясняй, зачем нужен текущий этап, а не только что сделано;',
  '- если неделя была только поддерживающей встречей без продвижения — честно напиши',
  '  короткое касание, не выдумывай результат;',
  '- пиши от первого лица множественного числа ("мы") — сообщение от лица команды/куратора,',
  '  никогда не говори о "кураторе" в третьем лице по отношению к себе;',
  '- используй привычную для семьи форму имени участника (см. ниже).',
  '',
  'Язык: профессиональный, спокойный, взрослый, уверенный, без канцелярита и воды.',
  'Опорные слова: определили, сформулировали, уточнили, зафиксировали, подготовили,',
  'начали, завершили, следующим шагом станет, после этого вместе разберём.',
  'Избегать: поговорили/обсудили/рассказали без результата после них.',
  '',
  'Формат ответа — СТРОГО такой текст целиком, без пояснений от себя и без markdown-разметки:',
  '',
  '{parents}, здравствуйте!',
  '',
  'to_replace_arrow Отчёт по треку {name} за период {period}',
  '',
  'to_replace_circle Синхронизация с куратором',
  '',
  '<2-4 коротких абзаца по правилам выше>',
  '',
  'to_replace_circle Дальнейшие шаги',
  '',
  '<1-2 абзаца: конкретный, подтверждённый следующий шаг>',
]
  .join('\n')
  .replace(/to_replace_arrow/g, '\u27A1\uFE0F')
  .replace(/to_replace_circle/g, '🔸');

function writeReport_(participant, period, transcriptText) {
  var cfg = getConfig_();
  var userMessage =
    'Родитель(и): ' + participant.parents + '\n' +
    'Имя участника (использовать как есть, не менять форму): ' + participant.fio.split(' ')[1] + '\n' +
    'Период отчёта: ' + period + '\n\n' +
    'Полный транскрипт встречи (реплики спикеров):\n' + transcriptText;

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system: STYLE_GUIDE,
      messages: [{ role: 'user', content: userMessage }],
    }),
    muteHttpExceptions: true,
  });
  var payload = JSON.parse(resp.getContentText());
  if (payload.error) {
    throw new Error('Anthropic API error: ' + JSON.stringify(payload.error));
  }
  return payload.content[0].text.trim();
}

// ===== Telegram =====

function sendTelegramMessage_(text) {
  var cfg = getConfig_();
  var url = 'https://api.telegram.org/bot' + cfg.telegramBotToken + '/sendMessage';
  var chunks = [];
  for (var i = 0; i < text.length; i += 4096) chunks.push(text.slice(i, i + 4096));
  chunks.forEach(function (chunk) {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: cfg.telegramChatId, text: chunk }),
      muteHttpExceptions: true,
    });
    var payload = JSON.parse(resp.getContentText());
    if (!payload.ok) throw new Error('Telegram API error: ' + JSON.stringify(payload));
  });
}

// ===== Основной процесс =====

function formatPeriod_(fromDate, toDate) {
  function ddmm(d) { return Utilities.formatDate(d, 'Europe/Moscow', 'dd.MM'); }
  return ddmm(fromDate) + '\u2013' + ddmm(toDate);
}

function weeklyRun() {
  var toDate = new Date();
  var fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  var period = formatPeriod_(fromDate, toDate);

  var roster = getRoster_();
  var allMeetings = getTranscriptsList_(fromDate, toDate);

  var sentFor = [];
  var skippedFor = [];

  roster.forEach(function (participant) {
    var meetings = findMeetingsFor_(participant.fio, allMeetings);
    if (meetings.length === 0) {
      skippedFor.push(participant.fio + ' (встреч не найдено)');
      return;
    }

    // Берём полный текст всех найденных встреч участника за неделю и склеиваем.
    var transcriptParts = [];
    var hasContent = false;
    meetings.forEach(function (m) {
      var text = getFullTranscript_(m.id);
      if (text && text.length > 50) {
        hasContent = true;
        transcriptParts.push('=== ' + m.title + ' (' + m.date + ') ===\n' + text);
      }
    });

    if (!hasContent) {
      skippedFor.push(participant.fio + ' (транскрипт пуст/не готов)');
      return;
    }

    var reportText = writeReport_(participant, period, transcriptParts.join('\n\n'));
    var header = participant.fio + ' \u2014 ' + participant.parents + ' \u2014 ' + participant.messenger;
    sendTelegramMessage_(header + '\n\n' + reportText);
    sentFor.push(participant.fio);

    Utilities.sleep(1000); // не долбить API подряд без пауз
  });

  Logger.log('Отправлены: ' + sentFor.join(', '));
  Logger.log('Пропущены: ' + skippedFor.join(', '));
}

/**
 * Разовая настройка триггера — запустить ИЗ РЕДАКТОРА один раз вручную
 * (выбрать эту функцию в выпадающем списке и нажать Run).
 * Ставит еженедельный запуск weeklyRun() на пятницу ~11:00 (часовой пояс
 * проекта должен быть Europe/Moscow — см. README.md).
 */
function createWeeklyTrigger() {
  // Сначала удалим старые триггеры этой функции, чтобы не задвоить.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weeklyRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('weeklyRun')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(11)
    .nearMinute(0)
    .create();
  Logger.log('Триггер создан: пятница, ~11:00 (часовой пояс проекта).');
}
