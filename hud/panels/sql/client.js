// dsh-hud › sql panel — browser half.
//
// The card is a database browser: pick a connection, read its schema, write one
// statement, read the answer. It owns nothing but presentation — every decision that
// could be wrong (which statement runs, whether a write is allowed, what the row cap
// is) is made on the host, where it can be enforced.
//
// Three things this card is deliberate about:
//
//   • A FAILED CONNECTION IS NOT AN EMPTY DATABASE. "0 tables" for a server that
//     refused the login is the most misleading thing this panel could say, so the
//     error takes the whole card and says which database it was about.
//   • THE READ-ONLY MECHANISM IS NAMED. SQLite refuses at the file handle, Postgres
//     and MySQL refuse in a read-only transaction — so the card says which one is
//     protecting you rather than a generic "read-only" that means three things.
//   • A WRITE NEEDS TWO TICKS. The connection must be writable AND the run must be
//     ticked, and the refusal names the one that is missing.
//
// Rendered with `jsx`/`jsxs` only — the shell provides them (see the fragment
// contract), and the suite checks for array children passed to `jsx`.

/** The result grid. A value is never rendered as `undefined` or as `[object Object]`. */
function SqlResult(props) {
  const { result, zh } = props
  if (result === null || result === undefined) return null
  /**
   * Show a value the way a person reads it.
   *
   * `null` is shown as a dimmed NULL rather than as an empty cell, because an empty
   * string and a NULL are different answers and a grid that draws them the same is
   * a grid that lies about one of them.
   */
  const show = (value) => {
    if (value === null) return jsx('span', { className: 'sq-null', children: 'NULL' })
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    const text = String(value)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }
  return jsxs('div', { className: 'sq-result', children: [
    // ── the headline says WHICH of the two things happened ──
    //
    // A read and a write are different answers, and the card used to report both as "执行结果"
    // with a row count of zero for a write. Someone who ran an UPDATE wants to know how many
    // rows it touched; someone who ran a SELECT wants the grid. The distinction is the whole
    // reason this card exists rather than a generic console.
    jsxs('div', { className: 'sq-reshead', children: [
      jsx('span', {
        className: `sq-restitle${result.columns.length === 0 ? ' is-ok' : ''}`,
        children: result.columns.length === 0
          ? (zh ? '执行成功' : 'statement succeeded')
          : `${zh ? '查询' : 'query'} · ${result.rows.length} ${zh ? '行' : 'rows'}`,
      }),
      result.columns.length === 0 && result.rowCount !== undefined && result.rowCount !== null
        ? jsx('span', { className: 'sq-affected', children: zh
          ? `影响 ${result.rowCount} 行`
          : `${result.rowCount} rows affected` })
        : null,
      result.truncated
        ? jsx('span', { className: 'sq-warn', children: zh
          ? `已截断到 ${result.limit} 行 —— 上限可在设置里调`
          : `truncated at ${result.limit} rows` })
        : null,
      jsx('span', { className: 'sq-ms', children: `${result.ms}ms` }),
      result.readOnly
        ? jsx('span', { className: 'sq-chip', children: zh ? '只读' : 'read-only' })
        : jsx('span', { className: 'sq-chip is-write', children: zh ? '可写' : 'writable' }),
    ] }),
    result.notice !== undefined && result.columns.length === 0
      ? jsx('span', { className: 'sq-notice', children: result.notice })
      : null,
    result.columns.length > 0
      ? jsx('div', { className: 'sq-scroll', children: jsxs('table', { className: 'sq-table', children: [
          jsx('thead', { children: jsx('tr', { children: result.columns.map((name, index) => jsx('th', {
            title: result.types?.[index] ?? name,
            children: name,
          }, `${name}-${index}`)) }) }),
          jsx('tbody', { children: result.rows.length === 0
            ? jsx('tr', { children: jsx('td', { colSpan: result.columns.length, className: 'sq-empty', children: zh ? '没有数据' : 'no rows' }) })
            : result.rows.map((row, rowIndex) => jsx('tr', {
                children: row.map((value, colIndex) => jsx('td', {
                  title: value === null ? 'NULL' : String(value),
                  children: show(value),
                }, `${rowIndex}-${colIndex}`)),
              }, `r${rowIndex}`)) }),
        ] }) })
      : null,
    result.notice !== undefined && result.columns.length > 0
      ? jsx('span', { className: 'sq-notice', children: result.notice })
      : null,
  ] })
}


/**
 * ── connecting to a database, in three steps and in the card ───────────────
 *
 * Pick the engine, fill in what THAT engine needs, press Connect. The parameters change
 * with the engine because they come from the same list the host exports for its own
 * form — there is no second opinion about what PostgreSQL asks for.
 *
 * Why this is in the card and not only in ⚙: "add a connection" is the FIRST thing
 * anyone does with this panel, and the empty state used to answer it with a paragraph
 * telling them to go and find the gear. The gear still edits an existing connection;
 * this is how one gets made.
 *
 * Connect TESTS BEFORE SAVING. A connection that is written to the settings file and
 * then fails is a broken thing to hand someone — the button is called Connect, so it
 * connects, and only a connection that worked becomes the active one.
 */
/**
 * Which engine — one control, used by both connection forms.
 *
 * Extracted the moment there were two forms (connect, and edit a stored connection):
 * two lists of engine buttons would drift, and the second one would eventually offer an
 * engine the first one disables. An engine this process cannot use is DISABLED here and
 * says why — offering it and failing at connect time would look like a network problem.
 */
function DriverChips({ zh, drivers, value, onPick }) {
  return jsxs('div', { className: 'sq-dtypes', role: 'group', children: drivers.map((driver) => jsxs('button', {
    type: 'button',
    className: `sq-dtype${value === driver.id ? ' is-on' : ''}`,
    'data-driver': driver.id,
    'aria-pressed': value === driver.id ? 'true' : 'false',
    disabled: driver.available !== true,
    title: driver.available === true
      ? (zh ? `连接 ${driver.labelZh ?? driver.label}` : `Connect to ${driver.label}`)
      : `${driver.labelZh ?? driver.label}：${driver.reason}`,
    onClick: () => onPick(driver.id),
    children: [
      driver.labelZh ?? driver.label,
      driver.available === true ? null : jsx('em', { children: zh ? '不可用' : 'n/a' }),
    ],
  }, driver.id)) })
}

/**
 * What one engine needs, plus the password box — shared by both forms.
 *
 * The password is NOT part of the driver's field list, because it is not part of the
 * connection: the connection stores a credential NAME. But asking someone to pre-create a
 * named credential before they can connect is how they end up reading "凭据无效" after
 * typing a perfectly good password. So the secret is typed here, used for the test, and
 * written to the credential store under a name the form shows.
 */
function SqlFields({ zh, drivers, driver, value, onChange, passwordHint }) {
  // SQLite is a file: it has no password, so it does not get a password box. Every other
  // driver authenticates, and every one of them stores the secret in the credential store
  // rather than in the connection.
  const needsPassword = driver !== 'sqlite'
  return jsxs('div', { className: 'sq-dfields', children: [
    ...driverFields(driver, drivers, zh).map((field) => jsxs('label', {
      className: `sq-dfield is-${field.kind}`,
      children: [
        jsx('span', { className: 'sq-dlabel', children: field.label }),
        field.kind === 'toggle'
          ? jsx('input', {
              type: 'checkbox',
              'data-field': field.key,
              checked: value[field.key] === true,
              onChange: (event) => onChange({ [field.key]: event.target.checked }),
            })
          : jsx('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              'data-field': field.key,
              value: value[field.key] === undefined ? '' : String(value[field.key]),
              placeholder: field.placeholder ?? '',
              min: field.min,
              max: field.max,
              spellCheck: false,
              onChange: (event) => onChange({
                [field.key]: field.kind === 'number'
                  ? (event.target.value === '' ? '' : Number(event.target.value))
                  : event.target.value,
              }),
            }),
        field.hint === undefined ? null : jsx('span', { className: 'sq-dhint', children: field.hint }),
      ],
    }, field.key)),
    needsPassword
      ? jsxs('label', { className: 'sq-dfield is-password', children: [
          jsx('span', { className: 'sq-dlabel', children: zh ? '密码' : 'PASSWORD' }),
          jsx('input', {
            type: 'password',
            'data-field': 'password',
            autoComplete: 'new-password',
            value: value.password === undefined ? '' : String(value.password),
            placeholder: zh ? '数据库密码' : 'database password',
            spellCheck: false,
            onChange: (event) => onChange({ password: event.target.value }),
          }),
          jsx('span', {
            className: 'sq-dhint',
            children: passwordHint ?? (value.passwordRef === undefined || String(value.passwordRef).trim() === ''
              ? (zh ? '连接成功后写入 DSH 凭据库，连接里只留名字。' : 'stored in the DSH credential store on success; the connection keeps only a name.')
              : (zh ? `写入凭据「${String(value.passwordRef).trim()}」。` : `written to the credential "${String(value.passwordRef).trim()}".`)),
          }),
        ] })
      : null,
  ] })
}

/**
 * ── the connection manager ───────────────────────────────────────────────────
 *
 * Several connections can be stored, and until now the only way to manage them was a row
 * of chips followed by a row of ✕ buttons — so with three connections on screen, the
 * third ✕ belonged to the third chip only by counting, and EDITING anything meant first
 * making it active and then editing "the connection", whatever that was. Add, remove and
 * modify all existed; none of them were safe.
 *
 * This is the list: ONE row per connection, each carrying its own actions, with a draft
 * editor underneath. What it deliberately does NOT do:
 *
 *   • it does not save as you type — the draft is local until 保存, so a half-typed
 *     hostname never reaches the settings file (the shell form writes on every keystroke,
 *     which is fine for a city name and wrong for a database host);
 *   • it does not delete on one click — deleting a connection is destructive and the
 *     credential behind it may be shared;
 *   • it does not hide a missing credential. A connection whose credential was removed
 *     fails with a sentence about the credential; showing that HERE means the list answers
 *     "which one is broken?" before anyone clicks it.
 */
function SqlConnectionRow(props) {
  const { zh, entry, drivers, active, busy, confirming, dropCredential } = props
  const spec = drivers.find((one) => one.id === entry.driver)
  const isActive = entry.id === active
  const missing = entry.credential === 'missing'
  return jsxs('div', {
    className: `sq-connrow${isActive ? ' is-on' : ''}${confirming ? ' is-confirming' : ''}`,
    'data-conn': entry.id,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'sq-connpick',
        'data-act': 'conn-pick',
        'aria-pressed': isActive ? 'true' : 'false',
        title: zh ? `正在使用：${entry.target}` : `in use: ${entry.target}`,
        onClick: () => props.onSelect(entry.id),
        children: [
          jsx('span', { className: 'sq-connname', children: entry.name }),
          jsx('span', { className: 'sq-conntarget', children: entry.target }),
        ],
      }),
      jsxs('span', { className: 'sq-connmeta', children: [
        jsx('em', { className: 'sq-tag', children: spec?.labelZh ?? entry.driver }),
        entry.readOnly === false
          ? jsx('em', { className: 'sq-tag is-write', children: zh ? '可写' : 'writes' })
          : null,
        missing
          ? jsx('em', {
              className: 'sq-tag is-warn',
              title: zh
                ? `凭据「${entry.passwordRef}」不在凭据库里，这个连接会连不上`
                : `credential "${entry.passwordRef}" is not in the store`,
              children: zh ? '凭据缺失' : 'no credential',
            })
          : null,
      ] }),
      confirming
        ? jsxs('span', { className: 'sq-connconfirm', children: [
            jsx('span', { className: 'sq-note', children: zh ? `删除「${entry.name}」？` : `Delete "${entry.name}"?` }),
            entry.passwordRef === undefined || entry.passwordRef === ''
              ? null
              : jsxs('label', {
                  className: 'sq-dfield is-toggle is-tight',
                  title: zh
                    ? '默认保留：别的连接可能也在用同一个凭据'
                    : 'kept by default: another connection may name the same credential',
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      'data-field': 'dropCredential',
                      checked: dropCredential === true,
                      onChange: (event) => props.onDropCredential(event.target.checked),
                    }),
                    jsx('span', { className: 'sq-dhint', children: zh ? `同时删除凭据 ${entry.passwordRef}` : `also delete ${entry.passwordRef}` }),
                  ],
                }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-danger',
              'data-act': 'conn-del-confirm',
              disabled: busy,
              onClick: () => props.onDelete(entry),
              children: zh ? '删除' : 'Delete',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'conn-del-cancel',
              disabled: busy,
              onClick: () => props.onCancelConfirm(),
              children: zh ? '取消' : 'Cancel',
            }),
          ] })
        : jsxs('span', { className: 'sq-connactions', children: [
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'conn-edit',
              disabled: busy,
              title: zh ? '修改这个连接' : 'edit this connection',
              onClick: () => props.onEdit(entry),
              children: zh ? '改' : 'edit',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'conn-copy',
              disabled: busy || props.full === true,
              title: zh ? '复制一份（共用同一个凭据）' : 'duplicate (shares the credential)',
              onClick: () => props.onCopy(entry),
              children: zh ? '复制' : 'copy',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-danger',
              'data-act': 'conn-del',
              disabled: busy,
              title: zh ? '删除这个连接' : 'delete this connection',
              onClick: () => props.onAskDelete(entry.id),
              children: zh ? '删除' : 'delete',
            }),
          ] }),
    ],
  })
}

/**
 * The draft editor — for a new connection, or for an existing one.
 *
 * ONE editor for both, because "add" and "modify" differ only in what happens on save:
 * add appends, modify replaces in place. Two forms would drift, and the second one would
 * forget the test-before-saving rule.
 */
function SqlConnectionEditor(props) {
  const { zh, drivers, mode, draft, outcome, testing, saving, tested } = props
  return jsxs('div', { className: 'sq-editor', children: [
    jsx('span', {
      className: 'sq-connect-head',
      children: mode === 'new' ? (zh ? '新建连接' : 'NEW CONNECTION') : (zh ? '修改连接' : 'EDIT CONNECTION'),
    }),
    jsxs('div', { className: 'sq-dfields', children: [
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '显示名' : 'NAME' }),
        jsx('input', {
          type: 'text',
          'data-field': 'name',
          value: draft.name === undefined ? '' : String(draft.name),
          placeholder: zh ? '例如 生产库' : 'e.g. production',
          spellCheck: false,
          onChange: (event) => props.onDraft({ name: event.target.value }),
        }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-number', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '行数上限' : 'ROW LIMIT' }),
        jsx('input', {
          type: 'number',
          'data-field': 'limit',
          min: 1,
          max: 5000,
          value: draft.limit === undefined ? '' : String(draft.limit),
          onChange: (event) => props.onDraft({ limit: event.target.value === '' ? '' : Number(event.target.value) }),
        }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-toggle', children: [
        jsx('input', {
          type: 'checkbox',
          'data-field': 'readOnly',
          checked: draft.readOnly !== false,
          onChange: (event) => props.onDraft({ readOnly: event.target.checked }),
        }),
        jsx('span', { className: 'sq-dlabel', children: zh ? '只读连接' : 'READ-ONLY' }),
        jsx('span', { className: 'sq-dhint', children: zh ? '关掉之后还要在卡片上勾选「允许写」才会真的写。' : 'still needs the card tick to write.' }),
      ] }),
    ] }),
    jsx(DriverChips, { zh, drivers, value: draft.driver, onPick: (id) => props.onDriver(id) }),
    jsx(SqlFields, {
      zh,
      drivers,
      driver: draft.driver,
      value: draft,
      onChange: (patch) => props.onDraft(patch),
      // An existing connection that already names a credential: leaving the box empty
      // KEEPS it, which is the only sane reading of an empty password box on an edit.
      passwordHint: mode === 'edit' && typeof draft.passwordRef === 'string' && draft.passwordRef !== ''
        ? (zh ? `留空则继续用凭据「${draft.passwordRef}」；填了就覆盖它。` : `leave empty to keep the credential "${draft.passwordRef}".`)
        : undefined,
    }),
    jsxs('div', { className: 'sq-dorun', children: [
      jsx('button', {
        type: 'button',
        className: 'sq-connect-cancel',
        'data-act': 'conn-test',
        disabled: testing === true || saving === true,
        onClick: () => props.onTest(),
        children: testing === true ? (zh ? '测试中…' : 'testing…') : (zh ? '测试' : 'Test'),
      }),
      jsx('button', {
        type: 'button',
        className: 'sq-connect-go',
        'data-act': 'conn-save',
        disabled: saving === true || testing === true,
        onClick: () => props.onSave(),
        // The LABEL carries the warning rather than a hidden rule: a connection that has
        // not been tested still saves, because the server being briefly unreachable must
        // not lock someone out of fixing a typo — but they are told what they are doing.
        children: saving === true
          ? (zh ? '保存中…' : 'saving…')
          : tested === true
            ? (zh ? '保存' : 'Save')
            : (zh ? '未测试，仍要保存' : 'save untested'),
      }),
      jsx('button', {
        type: 'button',
        className: 'sq-connect-cancel',
        'data-act': 'conn-cancel',
        disabled: saving === true,
        onClick: () => props.onCancel(),
        children: zh ? '取消' : 'Cancel',
      }),
      outcome === null
        ? null
        : jsx('span', {
            className: `sq-outcome${outcome.ok ? ' is-ok' : ' is-bad'}`,
            role: outcome.ok ? 'status' : 'alert',
            children: outcome.text,
          }),
    ] }),
    jsx('span', { className: 'sq-dhint', children: zh
      ? '「测试」先连一次再决定要不要保存；密码只在测试通过后写入 DSH 凭据库，连接里只留名字。'
      : 'Test connects once before anything is stored; the password is only written to the credential store after it works.' }),
  ] })
}

/**
 * How many connections a card will hold.
 *
 * The same number the host enforces (`cleanProfiles` slices at 12), named here so the
 * button that adds the thirteenth is disabled rather than silently ignored.
 */
const MAX_CONNECTIONS = 12

/**
 * The engine's default port, from what the host exports.
 *
 * Prefilled rather than left blank: the port box being empty is what used to mean port 1
 * (see `cleanProfile`), and a field that shows 1433 is better than a field that has to be
 * known to be left alone.
 */
function defaultPortFor(driver, drivers) {
  const spec = drivers.find((one) => one.id === driver)
  return driver === 'sqlite' ? undefined : spec?.defaultPort
}

/** A fresh draft, in the same shape a stored connection has. */
function blankConnection(drivers, zh) {
  const driver = drivers.find((one) => one.available === true)?.id ?? 'sqlite'
  const port = defaultPortFor(driver, drivers)
  return { driver, name: '', readOnly: true, limit: 200, password: '', ...(port === undefined ? {} : { port }) }
}

/**
 * Move a draft to another engine.
 *
 * The driver-specific fields are rebuilt from the NEW driver's list and nothing else is
 * carried over: a host left behind by PostgreSQL has no meaning in SQLite, and a stored
 * field the target engine does not have is how a settings file ends up with values nobody
 * can see or remove.
 */
function withDriver(draft, driver, drivers, zh) {
  /**
   * Only the DRIVER-SPECIFIC part is rebuilt.
   *
   * Everything else — the name, the row limit, the read-only switch, the id — is the
   * connection's own and is carried over untouched. Rebuilding the whole object from the
   * field list is what dropped `readOnly` and `limit` on an engine switch, which no test
   * of the editor noticed and the older connect-panel test caught: a connection saved
   * after picking PostgreSQL came out with neither.
   */
  const driverKeys = new Set(drivers.flatMap((one) => (one.fields ?? []).map((field) => field.key)))
  const next = {}
  for (const [key, value] of Object.entries(draft)) {
    if (!driverKeys.has(key)) next[key] = value
  }
  next.driver = driver
  for (const field of driverFields(driver, drivers, zh)) {
    next[field.key] = draft[field.key] === undefined ? '' : draft[field.key]
  }
  /**
   * A port that was PREFILLED follows the engine; a port somebody typed is theirs to keep.
   *
   * The distinction is `previousDefault`: 1433 sitting in the box because SQL Server put it
   * there is not a decision, while 1444 is. (`port` here is the NEW engine's default — it
   * was briefly missing from this function, which made every engine switch throw.)
   */
  const port = defaultPortFor(driver, drivers)
  const previousDefault = defaultPortFor(draft.driver, drivers)
  const carried = next.port
  if (port !== undefined && (carried === '' || carried === null || carried === undefined || carried === previousDefault)) {
    next.port = port
  }
  return next
}

/** An id nothing else is using: `db`, then `db2`, `db3`… */
function nextConnectionId(connections) {
  const used = new Set(connections.map((entry) => String(entry.id)))
  let n = 1
  let id = 'db'
  while (used.has(id)) {
    n += 1
    id = `db${n}`
  }
  return id
}

/** What to call a connection that has no name yet. */
function defaultConnectionName(draft, id) {
  const own = String(draft.name ?? '').trim()
  if (own !== '') return own
  if (draft.driver === 'sqlite') return String(draft.file ?? '').trim() || id
  return String(draft.database ?? '').trim() || String(draft.host ?? '').trim() || id
}

function SqlConnect(props) {
  const { zh, drivers, draft, busy, outcome } = props
  const available = drivers.filter((driver) => driver.available === true)
  return jsxs('div', { className: 'sq-connect', children: [
    jsx('span', { className: 'sq-connect-head', children: zh ? '连接数据库' : 'CONNECT TO A DATABASE' }),
    // ── step 1: which engine ──
    jsx(DriverChips, {
      zh,
      drivers,
      value: draft.driver,
      // Through `withDriver`, so switching engine here behaves exactly as it does in the ⚙
      // editor: the field list is rebuilt, and a prefilled port follows the engine.
      onPick: (id) => (typeof props.onDriver === 'function' ? props.onDriver(id) : props.onDraft({ driver: id })),
    }),
    available.length === 0
      ? jsx('span', { className: 'sq-note', children: zh
        ? '这个进程里没有可用的数据库驱动。'
        : 'No database driver is available in this process.' })
      : null,
    // ── step 2: what that engine needs ──
    jsx(SqlFields, {
      zh,
      drivers,
      driver: draft.driver,
      value: draft,
      onChange: (patch) => props.onDraft(patch),
    }),
    // ── step 3: connect ──
    jsxs('div', { className: 'sq-dorun', children: [
      jsx('button', {
        type: 'button',
        className: 'sq-connect-go',
        'data-act': 'connect',
        disabled: busy === true || available.length === 0,
        onClick: () => props.onConnect(),
        children: busy === true ? (zh ? '连接中…' : 'connecting…') : (zh ? '连接' : 'Connect'),
      }),
      jsx('button', {
        type: 'button',
        className: 'sq-connect-cancel',
        'data-act': 'cancel',
        disabled: busy === true,
        onClick: () => props.onCancel(),
        children: zh ? '取消' : 'Cancel',
      }),
      outcome === null
        ? null
        : jsx('span', {
            className: `sq-outcome${outcome.ok ? ' is-ok' : ' is-bad'}`,
            role: outcome.ok ? 'status' : 'alert',
            children: outcome.text,
          }),
    ] }),
  ] })
}

/**
 * ── the SQL completer ────────────────────────────────────────────────────────
 *
 * WHAT THIS IS: identifier completion. It knows the words that exist — the SQL keywords, and
 * every schema, table and column the connection has actually reported — and offers the ones
 * that start with what is being typed. Pressing Tab puts the rest of the word in.
 *
 * WHAT THIS IS NOT: a SQL parser. It does not know that `select * from |` wants a table and
 * `where |` wants a column, so it offers both and lets the user choose. Ranking candidates by
 * what the grammar would accept is a real feature and a much larger one; claiming it with a
 * list that is merely alphabetical would be worse than the honest version, because people
 * would trust the order.
 *
 * The vocabulary comes from the SCHEMA, not from a hard-coded list, which is the whole point:
 * the names it offers are the names that exist in the database being queried.
 */

/** The keywords worth completing. Not exhaustive — the ones a hand-written query uses. */
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'INNER JOIN', 'OUTER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL',
  'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'ASC', 'DESC',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'WITH', 'UNION', 'UNION ALL',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
]

/**
 * Every word the schema makes available, most-specific first.
 *
 * `schema.table.column` and `table.column` are offered alongside the bare names, because the
 * qualified form is what a query with a JOIN needs and typing it by hand is where the typos
 * come from.
 */
function buildVocabulary(schema) {
  const words = new Set(SQL_KEYWORDS)
  for (const one of schema?.schemas ?? []) {
    if (one?.name) words.add(one.name)
    for (const object of one?.objects ?? []) {
      if (!object?.name) continue
      words.add(object.name)
      if (one.name) words.add(`${one.name}.${object.name}`)
      for (const column of object.columns ?? []) {
        if (!column?.name) continue
        words.add(column.name)
        words.add(`${object.name}.${column.name}`)
      }
    }
  }
  return [...words]
}

/**
 * The candidates for the word under the caret.
 *
 * `word` is the partial identifier being typed — empty after a space, which is the moment a
 * completer is most useful and also the moment a naive one shows all 400 words. So an empty
 * word offers only the KEYWORDS (a sensible starting point), and a non-empty one offers every
 * matching identifier.
 */
function completionsFor(vocabulary, word, limit = 8) {
  if (word === '') return SQL_KEYWORDS.slice(0, limit)
  const needle = word.toLowerCase()
  const starts = []
  const contains = []
  for (const candidate of vocabulary) {
    const lower = candidate.toLowerCase()
    if (lower === needle) continue
    if (lower.startsWith(needle)) starts.push(candidate)
    else if (lower.includes(needle)) contains.push(candidate)
    if (starts.length >= limit) break
  }
  // Prefix matches first: `ord` should offer `order_id` before `sales_order_id`.
  return [...starts, ...contains].slice(0, limit)
}

/** The identifier being typed at `caret`, and the range it occupies. */
function wordAt(text, caret) {
  const before = text.slice(0, caret)
  const match = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before)
  return { word: match?.[0] ?? '', from: caret - (match?.[0]?.length ?? 0), to: caret }
}

/**
 * Where the caret is, for a box that may not have focus.
 *
 * `selectionStart` only MEANS something while the element has focus — on an unfocused textarea
 * it is whatever the implementation last left there, and jsdom leaves 0. Reading it blindly
 * put the completion word at position 0, so completing after a programmatic value change (a
 * restored draft, a test) looked at the wrong end of the statement and offered nothing.
 *
 * Unfocused, the only sane caret is the end: that is where text goes next.
 */
function caretOf(element, value) {
  const end = String(value ?? '').length
  if (element === null || element === undefined) return end
  const focused = typeof element.ownerDocument?.activeElement === 'object'
    && element.ownerDocument.activeElement === element
  if (!focused) return end
  const at = element.selectionStart
  return typeof at === 'number' && at >= 0 && at <= end ? at : end
}

/**
 * ── the SSH half of the card ─────────────────────────────────────────────────
 *
 * The card is a database OR an SSH client, never both at once — so this is a separate
 * render path rather than a section underneath the query box. Two panels sharing one slot
 * would leave a person working out which button belonged to which, and the answer would
 * change with the mode.
 *
 * What it is honest about:
 *   • it runs COMMANDS, not a terminal. There is no PTY, so vim, top and a sudo password
 *     prompt do not work here — "systemctl status", "docker ps", "df -h", "tail -n 50" do;
 *   • there is no read-only switch, because a shell has none. The database side can promise
 *     not to send a write; this cannot promise anything about a command it was asked to run;
 *   • the engine is the SYSTEM's ssh (its agent, its ~/.ssh/config, its known_hosts), and
 *     the card says so on screen rather than only in a README.
 */
const SSH_AUTH = [
  { id: 'password', zh: '密码', en: 'PASSWORD', hint: '密码只写进 DSH 凭据库，主机里留一个名字' },
  { id: 'key', zh: '密钥文件', en: 'KEY FILE', hint: '用你本机的私钥，和 ssh -i 一样' },
  { id: 'agent', zh: '代理 / 配置', en: 'AGENT', hint: '交给 ssh-agent 和 ~/.ssh/config，什么都不用填' },
]

/** A fresh host draft: port 22, password auth, and strict host keys. */
function blankHost() {
  return { name: '', host: '', port: 22, user: '', auth: 'password', keyPath: '', password: '', acceptNewHostKey: false, timeoutMs: 20_000 }
}

/** An id nothing else is using. */
function nextHostId(hosts) {
  const used = new Set(hosts.map((entry) => String(entry.id)))
  let n = 1
  let id = 'ssh1'
  while (used.has(id)) {
    n += 1
    id = `ssh${n}`
  }
  return id
}

/** One stored host, with its own actions — the same shape as the connection rows. */
function SshHostRow(props) {
  const { zh, entry, active, busy, confirming } = props
  const isActive = entry.id === active
  const missing = entry.credential === 'missing'
  const auth = SSH_AUTH.find((one) => one.id === entry.auth)
  return jsxs('div', {
    className: `sq-connrow${isActive ? ' is-on' : ''}${confirming ? ' is-confirming' : ''}`,
    'data-host': entry.id,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'sq-connpick',
        'data-act': 'host-pick',
        'aria-pressed': isActive ? 'true' : 'false',
        title: zh ? `正在使用：${entry.target}` : `in use: ${entry.target}`,
        onClick: () => props.onSelect(entry.id),
        children: [
          jsx('span', { className: 'sq-connname', children: entry.name }),
          jsx('span', { className: 'sq-conntarget', children: entry.target }),
        ],
      }),
      jsxs('span', { className: 'sq-connmeta', children: [
        jsx('em', { className: 'sq-tag', children: zh ? (auth?.zh ?? entry.auth) : (auth?.en ?? entry.auth) }),
        entry.acceptNewHostKey === true
          ? jsx('em', { className: 'sq-tag is-write', title: zh ? '未知主机密钥会被自动接受' : 'unknown host keys are accepted', children: zh ? '接受新密钥' : 'accept-new' })
          : null,
        missing
          ? jsx('em', {
              className: 'sq-tag is-warn',
              title: zh ? `凭据「${entry.passwordRef}」不在凭据库里，这个主机会连不上` : `credential "${entry.passwordRef}" is missing`,
              children: zh ? '凭据缺失' : 'no credential',
            })
          : null,
      ] }),
      confirming
        ? jsxs('span', { className: 'sq-connconfirm', children: [
            jsx('span', { className: 'sq-note', children: zh ? `删除「${entry.name}」？` : `Delete "${entry.name}"?` }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-danger',
              'data-act': 'host-del-confirm',
              disabled: busy,
              onClick: () => props.onDelete(entry),
              children: zh ? '删除' : 'Delete',
            }),
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn',
              'data-act': 'host-del-cancel',
              disabled: busy,
              onClick: () => props.onCancelConfirm(),
              children: zh ? '取消' : 'Cancel',
            }),
          ] })
        : jsxs('span', { className: 'sq-connactions', children: [
            jsx('button', {
              type: 'button', className: 'sq-connbtn', 'data-act': 'host-edit', disabled: busy,
              title: zh ? '修改这个主机' : 'edit this host',
              onClick: () => props.onEdit(entry), children: zh ? '改' : 'edit',
            }),
            jsx('button', {
              type: 'button', className: 'sq-connbtn', 'data-act': 'host-copy', disabled: busy || props.full === true,
              title: zh ? '复制一份' : 'duplicate',
              onClick: () => props.onCopy(entry), children: zh ? '复制' : 'copy',
            }),
            jsx('button', {
              type: 'button', className: 'sq-connbtn is-danger', 'data-act': 'host-del', disabled: busy,
              title: zh ? '删除这个主机' : 'delete this host',
              onClick: () => props.onAskDelete(entry.id), children: zh ? '删除' : 'delete',
            }),
          ] }),
    ],
  })
}

/** The host editor: new, or an existing one. One form for both, as on the database side. */
function SshHostEditor(props) {
  const { zh, mode, draft, outcome, testing, saving, tested } = props
  const field = (key) => ({
    'data-field': key,
    value: draft[key] === undefined || draft[key] === null ? '' : String(draft[key]),
    spellCheck: false,
    onChange: (event) => props.onDraft({ [key]: event.target.value }),
  })
  return jsxs('div', { className: 'sq-editor', children: [
    jsx('span', { className: 'sq-connect-head', children: mode === 'new' ? (zh ? '新建主机' : 'NEW HOST') : (zh ? '修改主机' : 'EDIT HOST') }),
    jsxs('div', { className: 'sq-dfields', children: [
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '显示名' : 'NAME' }),
        jsx('input', { type: 'text', ...field('name'), placeholder: zh ? '例如 跳板机' : 'e.g. bastion' }),
      ] }),
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '主机' : 'HOST' }),
        jsx('input', { type: 'text', ...field('host'), placeholder: '10.0.0.10' }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-number', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '端口' : 'PORT' }),
        jsx('input', { type: 'number', min: 1, max: 65535, ...field('port') }),
      ] }),
      jsxs('label', { className: 'sq-dfield', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '用户' : 'USER' }),
        jsx('input', { type: 'text', ...field('user'), placeholder: 'root' }),
      ] }),
    ] }),
    jsxs('div', { className: 'sq-dtypes', role: 'group', children: SSH_AUTH.map((one) => jsx('button', {
      type: 'button',
      className: `sq-dtype${draft.auth === one.id ? ' is-on' : ''}`,
      'data-auth': one.id,
      'aria-pressed': draft.auth === one.id ? 'true' : 'false',
      onClick: () => props.onDraft({ auth: one.id }),
      children: zh ? one.zh : one.en,
    }, one.id)) }),
    jsx('span', { className: 'sq-dhint', children: zh
      ? (SSH_AUTH.find((one) => one.id === draft.auth)?.hint ?? '')
      : 'How this card authenticates.' }),
    draft.auth === 'key'
      ? jsxs('div', { className: 'sq-dfields', children: [
          jsxs('label', { className: 'sq-dfield', children: [
            jsx('span', { className: 'sq-dlabel', children: zh ? '私钥文件' : 'KEY FILE' }),
            jsx('input', { type: 'text', ...field('keyPath'), placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' }),
          ] }),
        ] })
      : null,
    draft.auth === 'password'
      ? jsxs('div', { className: 'sq-dfields', children: [
          jsxs('label', { className: 'sq-dfield is-password', children: [
            jsx('span', { className: 'sq-dlabel', children: zh ? '密码' : 'PASSWORD' }),
            jsx('input', {
              type: 'password',
              'data-field': 'password',
              autoComplete: 'new-password',
              value: draft.password === undefined ? '' : String(draft.password),
              onChange: (event) => props.onDraft({ password: event.target.value }),
            }),
            jsx('span', { className: 'sq-dhint', children: mode === 'edit' && typeof draft.passwordRef === 'string' && draft.passwordRef !== ''
              ? (zh ? `留空则继续用凭据「${draft.passwordRef}」；填了就覆盖它。` : `leave empty to keep "${draft.passwordRef}".`)
              : (zh ? '测试通过后写进 DSH 凭据库，主机里只留名字。' : 'stored in the credential store after a successful test.') }),
          ] }),
        ] })
      : null,
    jsxs('div', { className: 'sq-dfields', children: [
      jsxs('label', { className: 'sq-dfield is-toggle', title: zh ? '默认关：未知或变更的主机密钥会拒绝连接（和你的 ssh 一样）' : 'off by default: unknown host keys refuse to connect', children: [
        jsx('input', {
          type: 'checkbox',
          'data-field': 'acceptNewHostKey',
          checked: draft.acceptNewHostKey === true,
          onChange: (event) => props.onDraft({ acceptNewHostKey: event.target.checked }),
        }),
        jsx('span', { className: 'sq-dlabel', children: zh ? '接受新主机密钥' : 'ACCEPT NEW HOST KEY' }),
        jsx('span', { className: 'sq-dhint', children: zh ? '第一次连某台机器时要打开它。' : 'needed the first time you reach a host.' }),
      ] }),
      jsxs('label', { className: 'sq-dfield is-number', children: [
        jsx('span', { className: 'sq-dlabel', children: zh ? '超时（毫秒）' : 'TIMEOUT (ms)' }),
        jsx('input', { type: 'number', min: 2000, max: 300000, step: 1000, ...field('timeoutMs') }),
      ] }),
    ] }),
    jsxs('div', { className: 'sq-dorun', children: [
      jsx('button', {
        type: 'button', className: 'sq-connect-cancel', 'data-act': 'host-test',
        disabled: testing === true || saving === true,
        onClick: () => props.onTest(),
        children: testing === true ? (zh ? '测试中…' : 'testing…') : (zh ? '测试' : 'Test'),
      }),
      jsx('button', {
        type: 'button', className: 'sq-connect-go', 'data-act': 'host-save',
        disabled: saving === true || testing === true,
        onClick: () => props.onSave(),
        children: saving === true
          ? (zh ? '保存中…' : 'saving…')
          : tested === true ? (zh ? '保存' : 'Save') : (zh ? '未测试，仍要保存' : 'save untested'),
      }),
      jsx('button', {
        type: 'button', className: 'sq-connect-cancel', 'data-act': 'host-cancel',
        disabled: saving === true, onClick: () => props.onCancel(), children: zh ? '取消' : 'Cancel',
      }),
      outcome === null ? null : jsx('span', {
        className: `sq-outcome${outcome.ok ? ' is-ok' : ' is-bad'}`,
        role: outcome.ok ? 'status' : 'alert',
        children: outcome.text,
      }),
    ] }),
  ] })
}

/** The SSH card: hosts, a command box, and what came back. */
/**
 * ── a small terminal, because a terminal is what was asked for ───────────────
 *
 * The command box answered "run this and show me what came back". This answers the other
 * question: a live shell where `cd` sticks, a program can ask a question, and what is on
 * screen is what the far side drew.
 *
 * It is a SCREEN, not a log. A log appends bytes; a terminal has a grid, a cursor, and
 * programs that overwrite what they wrote a moment ago — which is why `less`, `top`, a
 * progress bar and line editing all look like nothing at all in a log, and work here.
 *
 * The subset is deliberate and covers what a shell actually does:
 *   • CR, LF, BS, TAB, BEL
 *   • CSI: cursor moves (A B C D H f G d), erase (J K), SGR colours, save/restore (s u),
 *     and `?…h/l` mode sets, ignored rather than obeyed
 *   • OSC: skipped to its terminator. Ubuntu's shell sends `]3008;…` on every prompt; a
 *     terminal that renders that as text is unreadable.
 * Full-screen apps that use the alternate screen (`?1049h`) are drawn into the same grid —
 * they work, but their output also lands in the scrollback, which is the one honest
 * difference from xterm.
 */
const TERMINAL_COLS = 100
const TERMINAL_ROWS = 26
const SCROLLBACK_LINES = 400

/** The 16 basic colours, as class names the stylesheet owns. */
const BASIC_FG = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
/** The xterm 256-colour palette, so `ls --color` and `git log` are not monochrome. */
function palette256(n) {
  const index = Number(n)
  if (!Number.isFinite(index) || index < 0 || index > 255) return undefined
  if (index < 16) return undefined // handled by the basic classes
  if (index < 232) {
    const i = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    return `rgb(${steps[Math.floor(i / 36) % 6]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`
  }
  const grey = 8 + (index - 232) * 10
  return `rgb(${grey},${grey},${grey})`
}

const blankCell = () => ({ ch: ' ', fg: '', bg: '', bold: false, dim: false })

/**
 * One screen: a grid of cells plus a scrollback of the lines that scrolled off the top.
 * @returns {{feed: (text: string) => boolean, rows: () => Array, scrolled: () => Array, reset: () => void}}
 */
function createScreen(cols = TERMINAL_COLS, rows = TERMINAL_ROWS) {
  let width = cols
  let height = rows
  const makeGrid = () => Array.from({ length: height }, () => Array.from({ length: width }, blankCell))
  let grid = makeGrid()
  let x = 0
  let y = 0
  let style = { fg: '', bg: '', bold: false, dim: false }
  let saved = { x: 0, y: 0 }
  const scrollback = []
  let state = 'text'
  let buffer = ''

  const clearRow = (row) => { grid[row] = Array.from({ length: width }, blankCell) }

  const scrollUp = () => {
    // The top line leaves the screen and joins the scrollback: that is what makes scrolling
    // back through `cat` output possible at all.
    scrollback.push(grid[0])
    if (scrollback.length > SCROLLBACK_LINES) scrollback.splice(0, scrollback.length - SCROLLBACK_LINES)
    grid = [...grid.slice(1), Array.from({ length: width }, blankCell)]
    y = Math.max(0, y - 1)
  }

  const newline = () => {
    y += 1
    if (y >= height) {
      y = height - 1
      scrollUp()
    }
  }

  const put = (ch) => {
    if (x >= width) {
      // No wrapping modes are implemented: a line that runs past the edge wraps, which is
      // what every terminal does by default.
      x = 0
      newline()
    }
    grid[y][x] = { ch, ...style }
    x += 1
  }

  /** SGR — the colour and weight codes. */
  const sgr = (params) => {
    const codes = params === '' ? [0] : params.split(';').map((one) => Number(one === '' ? 0 : one))
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]
      if (code === 0) style = { fg: '', bg: '', bold: false, dim: false }
      else if (code === 1) style = { ...style, bold: true }
      else if (code === 2) style = { ...style, dim: true }
      else if (code === 22) style = { ...style, bold: false, dim: false }
      else if (code === 39) style = { ...style, fg: '' }
      else if (code === 49) style = { ...style, bg: '' }
      else if (code >= 30 && code <= 37) style = { ...style, fg: BASIC_FG[code - 30] }
      else if (code >= 90 && code <= 97) style = { ...style, fg: `${BASIC_FG[code - 90]} bright` }
      else if (code >= 40 && code <= 47) style = { ...style, bg: BASIC_FG[code - 40] }
      else if (code >= 100 && code <= 107) style = { ...style, bg: `${BASIC_FG[code - 100]} bright` }
      else if (code === 38 || code === 48) {
        // 38;5;N (256) and 38;2;R;G;B (truecolour). Both are worth honouring: `ls --color`
        // uses the first and modern tools use the second.
        const extended = codes[i + 1]
        if (extended === 5) {
          const rgb = palette256(codes[i + 2])
          if (rgb !== undefined) style = code === 38 ? { ...style, fg: rgb } : { ...style, bg: rgb }
          i += 2
        } else if (extended === 2) {
          const rgb = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
          style = code === 38 ? { ...style, fg: rgb } : { ...style, bg: rgb }
          i += 4
        } else {
          i += 1
        }
      }
    }
  }

  /** One CSI sequence, once its final byte has arrived. */
  const csi = (raw) => {
    // A private-mode sequence (`?25l`) is a mode set, not a movement: ignored on purpose.
    const priv = raw.startsWith('?') || raw.startsWith('>') || raw.startsWith('=')
    const body = priv ? raw.slice(1) : raw
    const final = body.slice(-1)
    const params = body.slice(0, -1)
    if (priv) return
    const first = Number(params.split(';')[0] === '' ? 0 : params.split(';')[0])
    const n = Number.isFinite(first) && first !== 0 ? first : 1
    switch (final) {
      case 'A': y = Math.max(0, y - n); break
      case 'B': y = Math.min(height - 1, y + n); break
      case 'C': x = Math.min(width - 1, x + n); break
      case 'D': x = Math.max(0, x - n); break
      case 'G': x = Math.max(0, Math.min(width - 1, n - 1)); break
      case 'd': y = Math.max(0, Math.min(height - 1, n - 1)); break
      case 'H': case 'f': {
        const parts = params.split(';')
        const row = Number(parts[0] === '' || parts[0] === undefined ? 1 : parts[0])
        const col = Number(parts[1] === '' || parts[1] === undefined ? 1 : parts[1])
        y = Math.max(0, Math.min(height - 1, (Number.isFinite(row) && row > 0 ? row : 1) - 1))
        x = Math.max(0, Math.min(width - 1, (Number.isFinite(col) && col > 0 ? col : 1) - 1))
        break
      }
      case 'J': {
        const mode = Number(params === '' ? 0 : params)
        if (mode === 2 || mode === 3) {
          for (let row = 0; row < height; row += 1) clearRow(row)
          if (mode === 3) scrollback.length = 0
        } else if (mode === 0) {
          for (let col = x; col < width; col += 1) grid[y][col] = blankCell()
          for (let row = y + 1; row < height; row += 1) clearRow(row)
        } else if (mode === 1) {
          for (let col = 0; col <= x && col < width; col += 1) grid[y][col] = blankCell()
          for (let row = 0; row < y; row += 1) clearRow(row)
        }
        break
      }
      case 'K': {
        const mode = Number(params === '' ? 0 : params)
        if (mode === 0) for (let col = x; col < width; col += 1) grid[y][col] = blankCell()
        else if (mode === 1) for (let col = 0; col <= x && col < width; col += 1) grid[y][col] = blankCell()
        else clearRow(y)
        break
      }
      case 'm': sgr(params); break
      case 's': saved = { x, y }; break
      case 'u': x = saved.x; y = saved.y; break
      default: break // r, h, l, t, n, c, q … not needed for a shell
    }
  }

  return {
    feed(text) {
      if (text === '') return false
      let changed = false
      for (const ch of String(text)) {
        if (state === 'osc') {
          // OSC runs to BEL or ST. Ubuntu's prompt sends `]3008;…` every time.
          if (ch === '\u0007') state = 'text'
          else if (ch === '\u001b') state = 'osc-esc'
          continue
        }
        if (state === 'osc-esc') {
          state = ch === '\\' ? 'text' : 'osc'
          continue
        }
        if (state === 'esc') {
          if (ch === '[') { state = 'csi'; buffer = ''; continue }
          if (ch === ']') { state = 'osc'; continue }
          // ESC ( B, ESC ) 0, ESC =, ESC > …: single-character introductions, all ignorable.
          state = 'text'
          continue
        }
        if (state === 'csi') {
          buffer += ch
          if (ch >= '@' && ch <= '~') {
            csi(buffer)
            state = 'text'
            changed = true
          }
          continue
        }
        if (ch === '\u001b') { state = 'esc'; continue }
        if (ch === '\r') { x = 0; changed = true; continue }
        if (ch === '\n') { newline(); changed = true; continue }
        if (ch === '\b') { x = Math.max(0, x - 1); changed = true; continue }
        if (ch === '\t') { x = Math.min(width - 1, (Math.floor(x / 8) + 1) * 8); continue }
        if (ch === '\u0007' || ch === '\u0000') continue
        if (ch < ' ') continue
        put(ch)
        changed = true
      }
      return changed
    },
    /** The visible screen as rows of styled runs, ready to render. */
    rows() {
      return grid.map((row) => {
        const runs = []
        for (const cell of row) {
          const key = `${cell.fg}|${cell.bg}|${cell.bold ? 1 : 0}${cell.dim ? 1 : 0}`
          const last = runs[runs.length - 1]
          if (last !== undefined && last.key === key) last.text += cell.ch
          else runs.push({ key, text: cell.ch, fg: cell.fg, bg: cell.bg, bold: cell.bold, dim: cell.dim })
        }
        // Trailing blanks are not worth rendering; the grid is fixed-width.
        while (runs.length > 0 && /^ +$/.test(runs[runs.length - 1].text) && runs[runs.length - 1].fg === '') runs.pop()
        return runs
      })
    },
    /** What scrolled off the top, oldest first. */
    scrolled() {
      return scrollback.map((row) => row.map((cell) => cell.ch).join('').replace(/\s+$/, ''))
    },
    /** How many characters are on screen — the card uses it to decide whether to auto-scroll. */
    animated() {
      return grid.some((row) => row.some((cell) => cell.ch !== ' '))
    },
    reset() {
      grid = makeGrid()
      scrollback.length = 0
      x = 0
      y = 0
      style = { fg: '', bg: '', bold: false, dim: false }
      state = 'text'
      return true
    },
    /** The card tells the far side its size through `stty`; the grid follows. */
    resize(nextCols, nextRows) {
      width = Math.max(20, Math.min(400, Number(nextCols) || cols))
      height = Math.max(5, Math.min(200, Number(nextRows) || rows))
      grid = makeGrid()
      x = 0
      y = 0
      return true
    },
  }
}

/** Which key a card button sends, and what the terminal calls it. */
const TERMINAL_KEYS = [
  { id: 'ctrl-c', zh: 'Ctrl-C', en: 'Ctrl-C', data: '\u0003' },
  { id: 'tab', zh: 'Tab', en: 'Tab', data: '\t' },
  { id: 'up', zh: '↑', en: '↑', data: '\u001b[A' },
  { id: 'down', zh: '↓', en: '↓', data: '\u001b[B' },
  { id: 'ctrl-d', zh: 'Ctrl-D', en: 'Ctrl-D', data: '\u0004' },
  { id: 'ctrl-l', zh: 'Ctrl-L', en: 'Ctrl-L', data: '\u000c' },
]

/** The live terminal: what the far side drew, and a line to send it. */
function SshTerminal(props) {
  const { zh, session, pending, onKey, onLine, onClose, onSend } = props
  const [line, setLine] = React.useState('')
  const runs = session?.runs ?? []
  const scrolled = session?.scrolled ?? []

  const send = (data) => { if (data !== '' && data !== undefined) onSend(data) }
  const submit = () => {
    // A shell reads a line terminator, not a newline. Sending `\n` leaves the prompt waiting
    // for the rest of a line that never comes — a real terminal sends CR.
    send(`${line}\r`)
    setLine('')
  }

  return jsxs('div', { className: 'sq-term', children: [
    jsxs('div', { className: 'sq-termbar', children: [
      jsx('span', { className: `sq-termdot${session?.closed === true ? ' is-off' : ''}` }),
      jsx('span', { className: 'sq-termtarget', children: session?.target ?? '' }),
      jsx('span', { className: 'sq-note', children: pending === true
        ? (zh ? '连接中…' : 'connecting…')
        : session?.closed === true
          ? (zh ? `已断开${session.exitCode === null || session.exitCode === undefined ? '' : `（退出码 ${session.exitCode}）`}` : 'closed')
          : (zh ? '已连接' : 'open') }),
      jsx('span', { className: 'sq-termspace' }),
      ...TERMINAL_KEYS.map((key) => jsx('button', {
        type: 'button', className: 'sq-connbtn sq-termkey', 'data-key': key.id,
        disabled: session?.closed === true,
        title: zh ? `发送 ${key.zh}` : `send ${key.en}`,
        onClick: () => send(key.data),
        children: zh ? key.zh : key.en,
      }, key.id)),
      jsx('button', {
        type: 'button', className: 'sq-connbtn is-danger', 'data-act': 'term-close',
        onClick: () => onClose(),
        children: session?.closed === true ? (zh ? '清掉' : 'clear') : (zh ? '断开' : 'close'),
      }),
    ] }),
    scrolled.length === 0
      ? null
      : jsx('pre', { className: 'sq-termscroll', 'data-act': 'term-scrollback', children: scrolled.join('\n') }),
    jsxs('pre', {
      className: 'sq-termscreen',
      'data-act': 'term-screen',
      // Clicking the screen puts the caret back in the input: a terminal you have to aim at
      // is a terminal nobody uses.
      onClick: () => { props.focus() },
      children: runs.map((row, index) => jsx('div', { className: 'sq-termrow', children: row.length === 0
        ? ' '
        : row.map((run, at) => jsx('span', {
            className: `sq-termrun${run.bold ? ' is-bold' : ''}${run.dim ? ' is-dim' : ''}${run.fg === '' ? '' : ` fg-${run.fg.replace(/\s+/g, '-')}`}${run.bg === '' ? '' : ` bg-${run.bg.replace(/\s+/g, '-')}`}`,
            style: {
              ...(run.fg.startsWith('rgb') ? { color: run.fg } : {}),
              ...(run.bg.startsWith('rgb') ? { background: run.bg } : {}),
            },
            children: run.text === '' ? ' ' : run.text,
          }, `${index}-${at}`)) }, index)),
    }),
    jsxs('div', { className: 'sq-termline', children: [
      jsx('input', {
        className: 'sq-terminput',
        'data-field': 'terminal',
        ref: props.inputRef,
        value: line,
        spellCheck: false,
        autoComplete: 'off',
        placeholder: session?.closed === true ? (zh ? '已断开' : 'closed') : (zh ? '在这里输入，回车发送' : 'type here, Enter sends'),
        disabled: session?.closed === true,
        onChange: (event) => setLine(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); submit(); return }
          if (event.key === 'ArrowUp' && line === '') { event.preventDefault(); send('\u001b[A'); return }
          if (event.key === 'ArrowDown' && line === '') { event.preventDefault(); send('\u001b[B'); return }
          if (event.key === 'Tab') { event.preventDefault(); send('\t'); return }
          if (event.key === 'c' && event.ctrlKey === true) { event.preventDefault(); send('\u0003'); return }
          if (event.key === 'd' && event.ctrlKey === true && line === '') { event.preventDefault(); send('\u0004'); return }
          onKey?.(event)
        },
      }),
      jsx('button', {
        type: 'button', className: 'sq-connect-go', 'data-act': 'term-send',
        disabled: session?.closed === true,
        onClick: () => submit(),
        children: zh ? '发送' : 'Send',
      }),
    ] }),
  ] })
}

function SshCard(props) {

  const { zh, payload, busy, error, actions, modeSwitch } = props
  const hosts = payload?.hosts ?? []
  const capability = payload?.capability
  const active = payload?.activeHost ?? ''
  const host = hosts.find((entry) => entry.id === active)
  const [editing, setEditing] = React.useState(null)
  const [confirmId, setConfirmId] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [runError, setRunError] = React.useState(null)

  const last = result ?? payload?.last ?? null
  const ready = capability?.ok === true

  /**
   * ── the live terminal ───────────────────────────────────────────────────────
   *
   * The SCREEN lives in a ref, not in state: it is a grid that thousands of bytes get poured
   * into, and re-rendering on every byte would be a re-render per keystroke of the shell's
   * echo. State holds only a counter that says "the screen changed", plus where the reader
   * has got to on the far side's stream.
   */
  const screenRef = React.useRef(null)
  if (screenRef.current === null) screenRef.current = createScreen()
  const cursorRef = React.useRef(0)
  const inputRef = React.useRef(null)
  const [screenVersion, setScreenVersion] = React.useState(0)
  const [term, setTerm] = React.useState(null)
  const [starting, setStarting] = React.useState(false)

  const startTerminal = async () => {
    setStarting(true)
    setRunError(null)
    try {
      const json = await actions.openTerm(active)
      if (json?.ok !== true) {
        setRunError(json?.error ?? (zh ? '打不开终端' : 'could not open a terminal'))
        return
      }
      screenRef.current.reset()
      cursorRef.current = 0
      screenVersionRef.current += 1
      setScreenVersion(screenVersionRef.current)
      setTerm({ id: json.session?.id ?? active, target: json.session?.target ?? '', closed: false, exitCode: null, error: null })
      // The caret goes into the terminal: a terminal you have to click before typing is a
      // terminal that looks broken for the first second.
      setTimeout(() => { try { inputRef.current?.focus?.() } catch { /* not focused, fine */ } }, 0)
    } catch (failure) {
      setRunError(failure?.payload?.error ?? (failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setStarting(false)
    }
  }

  const screenVersionRef = React.useRef(0)
  const paint = () => {
    screenVersionRef.current += 1
    setScreenVersion(screenVersionRef.current)
  }

  const endTerminal = async () => {
    const id = term?.id ?? active
    setTerm(null)
    try { await actions.closeTerm(id) } catch { /* the session may already be gone */ }
  }

  const sendToTerminal = async (data) => {
    if (typeof data !== 'string' || data === '') return
    try {
      // The size travels with the keystrokes, which is the only moment the card knows both
      // its own width and which session it is talking to.
      await actions.sendTerm(term?.id ?? active, data, 100, 26)
    } catch {
      /* a keystroke that did not arrive is not worth an error banner */
    }
  }

  const run = async () => {
    if (String(command).trim() === '') return
    setRunning(true)
    setRunError(null)
    try {
      const json = await actions.run({ id: active, command })
      if (json?.ok === true) setResult(json.result)
      else {
        setResult(json?.result ?? null)
        setRunError(json?.error ?? (zh ? '执行失败' : 'failed'))
      }
    } catch (failure) {
      /**
       * A failed COMMAND is reported as data, and the shell turns `ok: false` into a throw
       * with the body attached — so the result has to be read back out of the error.
       *
       * Without this, a command that failed left the PREVIOUS command's output on screen:
       * exit 0, the old stdout, and a person concluding it worked. (The test that caught it
       * asked for a failing command and found the successful one still rendered.)
       */
      const payload = failure?.payload
      if (payload?.result !== undefined && payload.result !== null) setResult(payload.result)
      setRunError(payload?.error ?? (failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setRunning(false)
    }
  }

  React.useEffect(() => {
    if (term === null || term.closed === true) return undefined
    let alive = true
    const tick = async () => {
      try {
        const json = await actions.pollTerm(term.id, cursorRef.current)
        if (!alive) return
        if (json?.ok !== true) {
          setTerm((current) => (current === null ? current : { ...current, closed: true, error: json?.error ?? null }))
          return
        }
        cursorRef.current = json.cursor ?? cursorRef.current
        if (typeof json.data === 'string' && json.data !== '') {
          screenRef.current.feed(json.data)
          paint()
        }
        if (json.status === 'closed') {
          setTerm((current) => (current === null ? current : { ...current, closed: true, exitCode: json.exitCode, error: json.error ?? current.error }))
        }
      } catch {
        /* a poll that failed is retried in 700ms; a banner per dropped poll would be noise */
      }
    }
    const timer = setInterval(() => { tick().catch(() => {}) }, 700)
    tick().catch(() => {})
    return () => { alive = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term?.id, term?.closed])

  const summary = capability === undefined
    ? (zh ? '读取中…' : 'reading…')
    : ready !== true
      ? (zh ? `ssh 不可用：${capability.reason}` : `ssh unavailable: ${capability.reason}`)
      : hosts.length === 0
        ? (zh ? '还没有主机' : 'no hosts')
        : host === undefined
          ? (zh ? '没有选中的主机' : 'no active host')
          : `${host.target} · ${String(capability.version ?? '').split(',')[0]}`

  return jsxs('div', { className: 'sq-root', children: [
    jsxs('div', { className: 'sq-head', children: [
      jsx('span', { className: 'sq-title', children: 'SSH' }),
      jsx('span', { className: 'sq-sub', title: host?.target ?? '', children: summary }),
      jsxs('span', { className: 'sq-right', children: [
        modeSwitch,
        jsx('button', {
          type: 'button', className: 'sq-ghost', 'data-act': 'ssh-refresh', disabled: busy === true,
          onClick: () => actions.refresh(), children: busy === true ? (zh ? '读取中…' : 'reading…') : (zh ? '刷新' : 'Refresh'),
        }),
      ] }),
    ] }),

    error === null || error === undefined
      ? null
      : jsx('span', { className: 'sq-err', 'data-act': 'ssh-error', role: 'alert', children: error }),

    ready !== true
      ? jsx('span', { className: 'sq-note is-warn', 'data-act': 'ssh-unavailable', children: zh
        ? `这台机器上没有可用的 ssh 客户端：${capability?.reason ?? '未知原因'}`
        : `no usable ssh client here: ${capability?.reason ?? 'unknown'}` })
      : jsxs('div', { className: 'sq-sshrun', children: [
          // ── the live terminal, or the button that opens one ──
          term === null
            ? jsxs('div', { className: 'sq-dorun', children: [
                jsx('button', {
                  type: 'button', className: 'sq-connect-go', 'data-act': 'term-open',
                  disabled: starting === true || hosts.length === 0,
                  onClick: () => { startTerminal().catch(() => {}) },
                  children: starting === true
                    ? (zh ? '正在连接…' : 'connecting…')
                    : (zh ? '打开终端（可交互）' : 'open a terminal'),
                }),
                jsx('span', { className: 'sq-hint', children: zh
                  ? '一个常驻的登录 shell：cd 会保持、程序能提问、屏幕就是远端画的样子。'
                  : 'a live login shell: cd sticks, programs can ask questions.' }),
              ] })
            : jsx(SshTerminal, {
                zh,
                focus: () => { try { inputRef.current?.focus?.() } catch { /* fine */ } },
                inputRef,
                version: screenVersion,
                pending: starting,
                session: {
                  target: term.target,
                  closed: term.closed,
                  exitCode: term.exitCode,
                  runs: term.closed === true && term.error ? [[{ key: 'x', text: term.error, fg: 'red', bg: '', bold: false, dim: false }]] : screenRef.current.rows(),
                  scrolled: screenRef.current.scrolled(),
                },
                onSend: (data) => { sendToTerminal(data).catch(() => {}) },
                onClose: () => { endTerminal().catch(() => {}) },
              }),
          jsxs('div', { className: 'sq-dorun', children: [
            jsx('input', {
              className: 'sq-sshcmd',
              'data-field': 'command',
              value: command,
              placeholder: zh ? '在这台主机上执行一条命令，例如 systemctl status nginx' : 'run one command, e.g. uptime',
              spellCheck: false,
              onChange: (event) => setCommand(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') run().catch(() => {}) },
            }),
            jsx('button', {
              type: 'button', className: 'sq-connect-go', 'data-act': 'ssh-run',
              disabled: running === true || hosts.length === 0 || String(command).trim() === '',
              onClick: () => { run().catch(() => {}) },
              children: running === true ? (zh ? '执行中…' : 'running…') : (zh ? '执行' : 'Run'),
            }),
          ] }),
          jsxs('div', { className: 'sq-sshpresets', children: [
            [['uptime', 'uptime'], ['磁盘', 'df -h'], ['内存', 'free -m'], ['我是谁', 'id']].map(([label, text]) => jsx('button', {
              type: 'button', className: 'sq-connbtn', 'data-act': `ssh-preset-${text.split(' ')[0]}`,
              disabled: running === true || hosts.length === 0,
              onClick: () => setCommand(text),
              children: zh ? label : text,
            }, text)),
          ] }),
          runError === null
            ? null
            : jsx('span', { className: 'sq-err', role: 'alert', children: runError }),
          last === null
            ? jsx('span', { className: 'sq-hint', children: zh ? '单条命令的输出会显示在这里 —— 需要连续操作、需要程序提问、需要看屏幕，就用上面的终端。' : 'one-shot output appears here; use the terminal above when you need to interact.' })
            : jsxs('div', { className: 'sq-sshout', children: [
                jsxs('div', { className: 'sq-sshmeta', children: [
                  jsx('code', { children: last.command }),
                  jsx('span', { className: `sq-exit${last.ok ? ' is-ok' : ' is-bad'}`, children: last.code === null || last.code === undefined ? '—' : `exit ${last.code}` }),
                  jsx('span', { className: 'sq-note', children: `${last.ms}ms${last.truncated ? (zh ? ' · 输出已截断' : ' · truncated') : ''}` }),
                ] }),
                String(last.stdout ?? '') === ''
                  ? null
                  : jsx('pre', { className: 'sq-sshstdout', 'data-act': 'ssh-stdout', children: last.stdout }),
                String(last.stderr ?? '') === ''
                  ? null
                  : jsx('pre', { className: 'sq-sshstderr', 'data-act': 'ssh-stderr', children: last.stderr }),
              ] }),
        ] }),

    jsxs('div', { className: 'sq-conns', children: [
      hosts.length === 0
        ? jsx('span', { className: 'sq-note', children: zh
          ? '还没有主机。先测试，通过了才写进设置。'
          : 'No hosts yet. Test first — only a working one is stored.' })
        : null,
      ...hosts.map((entry) => jsx(SshHostRow, {
        zh,
        entry,
        active,
        busy: busy === true,
        full: hosts.length >= 12,
        confirming: confirmId === entry.id,
        onSelect: (id) => actions.selectHost(id),
        onEdit: (one) => { setConfirmId(''); setEditing({ mode: 'edit', draft: { ...one, password: '' }, outcome: null, tested: false }) },
        onCopy: (one) => actions.copyHost(one),
        onAskDelete: (id) => setConfirmId(id),
        onCancelConfirm: () => setConfirmId(''),
        onDelete: (one) => { setConfirmId(''); actions.deleteHost(one) },
      }, `host-${entry.id}`)),
      jsxs('div', { className: 'sq-connsrow', children: [
        jsx('button', {
          type: 'button', className: 'sq-connbtn is-add', 'data-act': 'host-new',
          disabled: busy === true || hosts.length >= 12,
          onClick: () => { setConfirmId(''); setEditing({ mode: 'new', draft: blankHost(), outcome: null, tested: false }) },
          children: zh ? '＋ 新建主机' : '+ new host',
        }),
        jsx('span', { className: 'sq-note', children: `${hosts.length}/12` }),
      ] }),
    ] }),
    editing === null
      ? null
      : jsx(SshHostEditor, {
          zh,
          mode: editing.mode,
          draft: editing.draft,
          outcome: editing.outcome,
          testing: editing.testing === true,
          saving: editing.saving === true,
          tested: editing.tested === true,
          onDraft: (patch) => setEditing((current) => (current === null ? current : { ...current, draft: { ...current.draft, ...patch }, tested: false })),
          onTest: () => actions.testHost(editing, setEditing),
          onSave: () => actions.saveHost(editing, setEditing),
          onCancel: () => setEditing(null),
        }),
  ] })
}

function SqlCard(props = {}) {

  const { startTimers } = props
  const zh = hud.pickLocale() === 'zh'
  /**
   * ── the alive guard, and the trap in it ────────────────────────────────────
   *
   * The ref starts `true`, so the ONE-LINE form of this effect looks right:
   *
   *     useEffect(() => () => { aliveRef.current = false }, [])
   *
   * It is wrong. If the cleanup ever runs while the component stays on screen — which
   * is what StrictMode's simulated unmount does, and what any host that re-runs effects
   * will do — the ref is left `false` FOREVER, because nothing sets it back. Every
   * `if (!aliveRef.current) return` then silently drops its update: the card keeps its
   * DOM, keeps its handlers, answers clicks, and never repaints again.
   *
   * That is exactly what happened to this card, and it is why its result grid looked
   * broken while every other panel was fine — they all use the version below, which
   * RE-ARMS the flag in the effect body. A guard on a live component has to be re-armed
   * every time the effect runs.
   */
  const aliveRef = React.useRef(true)
  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  /**
   * The last result and the last failure — their OWN state, not part of the snapshot.
   *
   * They used to live in the snapshot, which the poll REPLACES wholesale: a minute later the
   * table someone was reading vanished, and the only way to see it again was to run the query
   * a second time. A result is not a polled fact — it is the answer to a question the user
   * asked, and it stays on screen until they ask a different one.
   *
   * The host still caches the last result and reports it in `/state`, so a page reload brings
   * it back; `read` only adopts that when there is nothing local to keep.
   */
  const [result, setResult] = React.useState(null)
  const [queryError, setQueryError] = React.useState(null)
  /**
   * The completion list, or null when it is not showing.
   *
   * `{ items, index, from, to }` — the range matters: accepting a candidate replaces the word
   * under the caret and leaves the rest of the statement exactly as it was. Replacing the whole
   * box would be simpler and would destroy the query someone is halfway through writing.
   */
  const [suggest, setSuggest] = React.useState(null)
  const boxRef = React.useRef(null)
  /**
   * What the user has folded away in the schema tree.
   *
   * Two SETS of ids — `schema` and `schema.object` — rather than a flag per node, because the
   * tree arrives from the host on every poll and a node's open state must not be part of it.
   * Held as "closed" rather than "open" so the DEFAULT is expanded: a tree that starts folded
   * hides the very thing someone opened the card to look at, and nothing here is large enough
   * to need protecting from.
   */
  const [folded, setFolded] = React.useState(() => ({ schemas: new Set(), objects: new Set() }))
  const toggleFold = (kind, id) => setFolded((current) => {
    const next = new Set(current[kind])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { ...current, [kind]: next }
  })
  const [busy, setBusy] = React.useState(false)
  const [sql, setSql] = React.useState('')
  const [running, setRunning] = React.useState(false)
  /** The per-run write switch. Component state: it must not survive a reload. */
  const [allowWrite, setAllowWrite] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  /**
   * The connection being built, or null when the panel is closed.
   *
   * A draft, not a saved connection: nothing reaches the settings file until it has
   * actually connected. It starts on SQLite because that is the one engine that needs
   * no credential and no server, so the first try has a chance of working.
   */
  const [draft, setDraft] = React.useState(null)
  const [connecting, setConnecting] = React.useState(false)
  const [outcome, setOutcome] = React.useState(null)
  /**
   * The manager's own state: which connection is being edited, which row is asking to be
   * deleted, and whether that deletion should take the credential with it.
   *
   * `editing.draft` is LOCAL — nothing is written until 保存 — which is the difference
   * between this and the shared settings form it replaced: that one wrote every keystroke
   * into the settings file, so a half-typed hostname became the connection's host for as
   * long as it took to type the rest.
   */
  const [editing, setEditing] = React.useState(null)
  const [confirmId, setConfirmId] = React.useState('')
  const [dropCredential, setDropCredential] = React.useState(false)
  /** Whether the footer is asking before dropping every connection for the settings page. */
  const [resetAsk, setResetAsk] = React.useState(false)

  const read = React.useCallback(async (force = false) => {
    try {
      const json = force === true
        ? await hud.fetchJson('/dsh-hud/sql/refresh', { method: 'POST' })
        : await hud.fetchJson('/dsh-hud/sql/state')
      if (!aliveRef.current) return
      setSnapshot(json)
      // A page reload finds the host's cached last result; a POLL must never take the place of
      // the answer already on screen. Adopting only when there is nothing local means both.
      setResult((current) => current ?? json?.result ?? null)
      setQueryError((current) => current ?? json?.queryError ?? null)
      setError(null)
    } catch (failure) {
      if (!aliveRef.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  React.useEffect(() => {
    read(false).catch(() => {})
    // The snapshot is the CONNECTIONS and the cached schema; the poll only matters
    // when a connection is configured, which the host decides.
    const stop = startTimers?.(() => {
      // One card, one poll: the SSH side is not a database and has nothing to re-read on a
      // timer, so it re-reads its own (cheap) state instead of opening a database session.
      if (mode === 'ssh') readSsh().catch(() => {})
      else read(true).catch(() => {})
    }, snapshot?.pollMs ?? 60_000)
    return () => { if (typeof stop === 'function') stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, snapshot?.pollMs])

  const applySettings = (json) => {
    if (json?.settings === undefined) return
    setSnapshot((current) => (current === null ? current : { ...current, settings: json.settings }))
    /**
     * …and the panel-level facts the card needs even when there is NO snapshot.
     *
     * The mode switch goes through this: `mode`, `hosts` and `activeHost` live in the same
     * settings blob, and a switch that only landed in a snapshot the card may not have
     * would do nothing until a reload. That is the same mistake as the engine list coming
     * from the state payload — the fix is the same: the answer is kept where the card can
     * always see it.
     */
    setPanelInfo((current) => ({
      ...current,
      mode: json.settings.mode ?? current.mode,
      hosts: Array.isArray(json.settings.hosts) ? json.settings.hosts : current.hosts,
      activeHost: json.settings.activeHost ?? current.activeHost,
    }))
  }
  const settings = hud.useSettings('/dsh-hud/sql', applySettings)

  // `result` and `queryError` are their own state now — they must outlive the poll.
  const connections = snapshot?.connections ?? []
  const active = snapshot?.active ?? ''
  const schema = snapshot?.schema
  // Rebuilt only when the schema changes: the poll returns a new object every minute, and
  // rebuilding a few hundred strings each time would be work with no purpose.
  const vocabulary = React.useMemo(() => buildVocabulary(schema), [schema])
  const connection = connections.find((entry) => entry.id === active)
  const readOnly = connection?.readOnly !== false
  /**
   * The engines, from a route that does NOT touch a database.
   *
   * They used to come only from the state payload, so a card that could not read its state
   * had NO engine list — the 新建连接 form rendered no engine buttons at all and silently
   * stayed on SQLite ("数据库文件"), which is a form nobody can fill in to reach PostgreSQL
   * or SQL Server. Choosing an engine has nothing to do with whether a database is
   * reachable, so it is asked for separately, and the settings route answers it without
   * opening a socket.
   */
  const [panelInfo, setPanelInfo] = React.useState({ drivers: [], mode: undefined, hosts: [], activeHost: '' })
  React.useEffect(() => {
    let alive = true
    hud.fetchJson('/dsh-hud/sql/settings')
      .then((json) => {
        if (!alive) return
        setPanelInfo((current) => ({
          drivers: Array.isArray(json?.drivers) && json.drivers.length > 0 ? json.drivers : current.drivers,
          // WHICH CARD THIS IS comes from here as well as from the state payload, and that
          // matters: a card that cannot reach a database must still be able to switch to SSH.
          mode: json?.settings?.mode ?? current.mode,
          hosts: Array.isArray(json?.settings?.hosts) ? json.settings.hosts : current.hosts,
          activeHost: json?.settings?.activeHost ?? current.activeHost,
        }))
      })
      .catch(() => { /* the snapshot's own copy is the fallback */ })
    return () => { alive = false }
  }, [])
  const drivers = (snapshot?.drivers?.length ?? 0) > 0 ? snapshot.drivers : panelInfo.drivers
  // WHO is enforcing read-only, not just whether it is on. PostgreSQL and MySQL refuse a
  // write in a read-only transaction — the SERVER refuses. SQL Server has no read-only
  // transaction, so for that driver the refusal happens in this plugin, which is a weaker
  // promise and is labelled as such instead of borrowing the other drivers' wording.
  const engineReadOnly = (drivers.find((one) => one.id === connection?.driver)?.readonly ?? 'engine') !== 'client'
  /** The panel is open, or the card has nothing to show and is asking for a database. */
  const showConnect = draft !== null || (snapshot !== null && connections.length === 0)
  const openDraft = () => {
    setOutcome(null)
    // The same starting point the ⚙ editor uses, port included: one description of what a
    // new connection begins as, so the two forms cannot start differently.
    setDraft(blankConnection(drivers, zh))
  }
  /**
   * Test the draft, and only then keep it.
   *
   * "Connect" that writes a broken connection into the settings file is a lie about
   * what happened: the entry appears, the card looks configured, and every later read
   * fails. So the test comes first, and a failure leaves the settings untouched —
   * the draft stays on screen with the reason next to it.
   */
  const connect = async () => {
    if (draft === null) return
    const typed = typeof draft.password === 'string' ? draft.password : ''
    setConnecting(true)
    setOutcome(null)
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/test', {
        method: 'POST',
        // The password is sent WITH the test rather than looked up first. Asking for the
        // NAME of a credential that must already exist is what produced "凭据无效" for
        // someone who had just typed their password.
        body: JSON.stringify({ connection: draft, password: typed }),
      })
      if (!aliveRef.current) return
      if (json?.ok !== true) {
        setOutcome({ ok: false, text: json?.error ?? (zh ? '连接失败' : 'connection failed') })
        return
      }
      // A stable id that cannot collide with one already in use.
      const used = new Set(connections.map((entry) => entry.id))
      let id = 'db'
      let n = 1
      while (used.has(id)) { n += 1; id = `db${n}` }
      // The secret goes to the credential store and only its NAME goes into the
      // connection, so the settings file — and every state response the browser asks for —
      // still contains no password. Written AFTER the test passed: nothing is stored
      // before it is known to work.
      let passwordRef = String(draft.passwordRef ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_')
      if (typed !== '') {
        // UNDERSCORES, not hyphens: the credential store's refs match
        // /^[A-Za-z_][A-Za-z0-9_]*$/, and this name is generated from a connection id that can
        // contain anything. A hyphen here does not fail locally — it makes the credentials
        // plugin fail to load, and DSH will not start until the line is deleted by hand.
        if (passwordRef === '') passwordRef = `dsh_hud_sql_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`
        const stored = await hud.fetchJson('/dsh-hud/sql/credential', {
          method: 'POST',
          body: JSON.stringify({ ref: passwordRef, value: typed }),
        })
        if (!aliveRef.current) return
        if (stored?.ok !== true) {
          setOutcome({ ok: false, text: stored?.error ?? (zh ? '密码没能存进凭据库' : 'could not store the password') })
          return
        }
      }
      // The draft CARRIES the typed password, so it has to be taken out again by name.
      // Spreading the draft whole is what put `"password":"sup3r-s3cret"` into the settings
      // file — the test reads the actual request body, which is how it was caught. The
      // whole point of the credential store is that this file never holds a secret.
      const { password: _typed, ...withoutSecret } = draft
      const saved = {
        ...withoutSecret,
        passwordRef: passwordRef === '' ? undefined : passwordRef,
        id,
        name: String(draft.name ?? '').trim() || String(draft.database ?? '').trim() || String(draft.file ?? '').trim() || id,
      }
      settings.patch({ connections: [...connections.map((entry) => ({ ...entry })), saved], active: id })
      // `info` is an OBJECT (host, port, database, serverVersion…), so it is summarised
      // rather than interpolated — `已连接：[object Object]` is the kind of thing that
      // makes a working feature look broken.
      const info = json.info ?? {}
      const detail = [info.serverVersion, info.database, info.host].filter((part) => typeof part === 'string' && part !== '').join(' · ')
      setOutcome({
        ok: true,
        text: [
          zh ? '已连接' : 'connected',
          detail,
          json.ms === undefined ? '' : `${json.ms}ms`,
          // Say where the password went. A secret that disappears into a store the user
          // cannot see is a secret they will type again next time.
          typed === '' ? '' : (zh ? `密码已存入凭据 ${passwordRef}` : `password stored as ${passwordRef}`),
        ]
          .filter((part) => part !== '' && part !== undefined).join(' · '),
      })
      setDraft(null)
      // Read it back from the host rather than trusting the local copy: the settings
      // route is where the two can disagree, and the host is the one that opens sockets.
      await read(true)
    } catch (failure) {
      if (aliveRef.current) setOutcome({ ok: false, text: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      if (aliveRef.current) setConnecting(false)
    }
  }

  // ── the manager's handlers ─────────────────────────────────────────────
  //
  // Every one of them writes the WHOLE `connections` array plus `active`. A partial write
  // is how a settings screen silently deletes things, and the host stores the array whole.

  /** Open the editor on a connection that is already stored. */
  const startEdit = (entry) => {
    setConfirmId('')
    setEditing({
      mode: 'edit',
      // A copy, so typing cannot touch the snapshot the list is rendered from. `password`
      // starts empty and means "keep what is stored" — see the editor's own hint.
      draft: { ...entry, password: '' },
      outcome: null,
      tested: false,
      testing: false,
      saving: false,
    })
  }

  /** Open the editor on a new one. Nothing is stored until 保存. */
  const startNew = () => {
    setConfirmId('')
    setEditing({ mode: 'new', draft: blankConnection(drivers, zh), outcome: null, tested: false, testing: false, saving: false })
  }

  /** Test the draft against the host, without storing anything. */
  const testEditing = async () => {
    if (editing === null) return
    setEditing((current) => (current === null ? current : { ...current, testing: true, outcome: null }))
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/test', {
        method: 'POST',
        body: JSON.stringify({ connection: editing.draft, password: String(editing.draft.password ?? '') }),
      })
      if (!aliveRef.current) return
      const info = json?.info ?? {}
      const detail = [info.serverVersion, info.database, info.host, info.file].filter((part) => typeof part === 'string' && part !== '').join(' · ')
      setEditing((current) => (current === null ? current : {
        ...current,
        testing: false,
        tested: json?.ok === true,
        outcome: json?.ok === true
          ? { ok: true, text: [zh ? '测试通过' : 'ok', detail, json.ms === undefined ? '' : `${json.ms}ms`].filter((part) => part !== '').join(' · ') }
          : { ok: false, text: json?.error ?? (zh ? '连接失败' : 'connection failed') },
      }))
    } catch (failure) {
      if (aliveRef.current) {
        setEditing((current) => (current === null ? current : {
          ...current, testing: false, tested: false,
          outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
        }))
      }
    }
  }

  /**
   * Save the draft: the credential first (only when a password was typed), then the list.
   *
   * The password is written AFTER the test where there was one, exactly like the connect
   * flow — a secret that is stored for a connection that never worked is a secret written
   * for nothing. When there was no successful test the save still goes through, because a
   * server that is briefly down must not stop someone fixing a typo; the button says so.
   */
  const saveEditing = async () => {
    if (editing === null) return
    const { mode, draft: pending } = editing
    setEditing((current) => (current === null ? current : { ...current, saving: true }))
    try {
      const typed = typeof pending.password === 'string' ? pending.password : ''
      const id = mode === 'edit' ? String(pending.id) : nextConnectionId(connections)
      let passwordRef = String(pending.passwordRef ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_')
      if (typed !== '') {
        // UNDERSCORES, not hyphens: the credential store's refs match
        // /^[A-Za-z_][A-Za-z0-9_]*$/, and a hyphen here does not fail locally — it makes
        // the credentials plugin fail to load, and DSH will not start until the line is
        // deleted by hand.
        if (passwordRef === '') passwordRef = `dsh_hud_sql_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
        const stored = await hud.fetchJson('/dsh-hud/sql/credential', {
          method: 'POST',
          body: JSON.stringify({ ref: passwordRef, value: typed }),
        })
        if (!aliveRef.current) return
        if (stored?.ok !== true) {
          setEditing((current) => (current === null ? current : {
            ...current, saving: false, outcome: { ok: false, text: stored?.error ?? (zh ? '密码没能存进凭据库' : 'could not store the password') },
          }))
          return
        }
      }
      // The draft carries the typed password, so it is taken out AGAIN by name. Spreading
      // it whole is what once put `"password":"sup3r-s3cret"` into the settings file.
      const { password: _typed, target: _target, credential: _credential, ...rest } = pending
      const entry = {
        ...rest,
        id,
        name: defaultConnectionName(pending, id),
        passwordRef: passwordRef === '' ? undefined : passwordRef,
      }
      const next = mode === 'edit'
        // REPLACED IN PLACE: the list order is the order someone arranged for themselves,
        // and an edit that jumped the connection to the end would be a different list.
        ? connections.map((one) => (one.id === id ? entry : one))
        : [...connections, entry]
      /**
       * EDITING DOES NOT SWITCH CONNECTIONS.
       *
       * `active` is a separate decision from `connections`, and someone fixing a typo in
       * the standby connection should still be querying the one they were querying. Only
       * ADDING one makes it active — because you have just said you want to use it.
       */
      const stillThere = connections.some((one) => one.id === active)
      const nextActive = mode === 'edit' && stillThere ? active : id
      await settings.patch({ connections: next, active: nextActive })
      if (!aliveRef.current) return
      setEditing(null)
      // Read it back from the host rather than trusting the local copy: the host cleans
      // and defaults what it stores, and it is the one that opens sockets.
      await read(true)
    } catch (failure) {
      if (aliveRef.current) {
        setEditing((current) => (current === null ? current : {
          ...current, saving: false, outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
        }))
      }
    }
  }

  /** Copy a connection: same settings, same credential, new id and name. */
  const copyConnection = async (entry) => {
    if (connections.length >= MAX_CONNECTIONS) return
    const id = nextConnectionId(connections)
    const { target: _target, credential: _credential, ...rest } = entry
    const copy = { ...rest, id, name: `${entry.name} ${zh ? '副本' : 'copy'}` }
    const at = connections.findIndex((one) => one.id === entry.id)
    const next = [...connections.slice(0, at + 1), copy, ...connections.slice(at + 1)]
    await settings.patch({ connections: next, active: copy.id })
    await read(true)
  }

  /**
   * Delete a connection — and the credential only if it was asked for.
   *
   * The credential is KEPT by default: two connections can name the same one (the same
   * database with and without writes), so removing one must not break the other. The host
   * refuses anyway while another connection still references it, and its refusal is shown
   * here rather than swallowed.
   */
  const deleteConnection = async (entry) => {
    const next = connections.filter((one) => one.id !== entry.id)
    const stillActive = snapshot?.active === entry.id ? (next[0]?.id ?? '') : (snapshot?.active ?? '')
    await settings.patch({ connections: next, active: stillActive })
    if (dropCredential === true && typeof entry.passwordRef === 'string' && entry.passwordRef !== '') {
      const removed = await hud.fetchJson('/dsh-hud/sql/credential/remove', {
        method: 'POST',
        body: JSON.stringify({ ref: entry.passwordRef }),
      })
      if (aliveRef.current && removed?.ok !== true && removed?.error !== undefined) {
        setEditing({ mode: 'new', draft: blankConnection(drivers, zh), outcome: { ok: false, text: removed.error }, tested: false, testing: false, saving: false })
      }
    }
    if (aliveRef.current) {
      setConfirmId('')
      setDropCredential(false)
    }
    await read(true)
  }

  /**
   * Show or hide the completion list for the caret's current word.
   *
   * Called on typing and on caret movement, and it does NOT run while a completion is being
   * accepted — otherwise the list would reopen on the word just completed and Tab would appear
   * to do nothing.
   */
  const refreshSuggest = (value, caret) => {
    const { word, from, to } = wordAt(value, caret)
    // One character is enough to be useful and short enough not to flash a list at every
    // keystroke; Ctrl+Space forces it even on an empty word.
    const items = word.length >= 1 ? completionsFor(vocabulary, word) : []
    setSuggest(items.length === 0 ? null : { items, index: 0, from, to })
  }

  /** Put a candidate into the box, replacing the word under the caret. */
  const acceptSuggest = (candidate) => {
    const box = boxRef.current
    const caret = box?.selectionStart ?? suggest?.to ?? sql.length
    const from = suggest?.from ?? caret
    const to = suggest?.to ?? caret
    const next = `${sql.slice(0, from)}${candidate}${sql.slice(to)}`
    setSql(next)
    setSuggest(null)
    // The caret goes AFTER the inserted word — in a `useEffect`, because React has not written
    // the new value into the DOM yet and setting selectionStart on the old value puts it back.
    const at = from + candidate.length
    React.startTransition?.(() => {})
    setTimeout(() => {
      const element = boxRef.current
      if (element === null) return
      element.focus()
      element.setSelectionRange(at, at)
    }, 0)
  }

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/query', {
        method: 'POST',
        body: JSON.stringify({ id: active, sql, allowWrite }),
      })
      if (!aliveRef.current) return
      // `ok: false` here is an ANSWER about the query (a refusal, a SQL error), not a
      // broken route — so it is shown where the result would be.
      if (json?.ok === false) {
        // The structured form when the host sent one, and the plain string when it did not —
        // a card that renders `undefined` for an old host is worse than one that shows less.
        const detail = json.queryError ?? { message: json.error ?? (zh ? '查询失败' : 'query failed') }
        setResult(null)
        setQueryError(detail)
      } else {
        setResult(json.result ?? null)
        setQueryError(null)
      }
    } catch (failure) {
      // The shell's fetchJson THROWS on `ok: false`, so a SQL error — which is an ANSWER about
      // the statement, not a broken route — arrives here rather than in the branch above. The
      // whole body is on the error, so the server's code, DETAIL and HINT survive instead of
      // being flattened into one sentence.
      const body = failure?.payload
      const detail = body?.queryError ?? {
        message: body?.error ?? (failure instanceof Error ? failure.message : String(failure)),
        code: body?.code,
      }
      if (aliveRef.current) {
        setResult(null)
        setQueryError(detail)
      }
    } finally {
      if (aliveRef.current) setRunning(false)
    }
  }

  /**
   * NO STATE AT ALL is a different thing from "no connections", and saying the wrong one
   * scares people: a page whose first state read failed has `snapshot === null`, and the
   * card used to render that as an empty list — "我的配置怎么都没有了" — when the settings
   * file had never been touched. A failed read says it failed.
   */
  /**
   * ── which card this is ──────────────────────────────────────────────────────
   *
   * `db` or `ssh`, and never both: the other side is not rendered and not polled. The
   * settings route answers this even when the database side is unreachable, which is the
   * only way to switch AWAY from a card that cannot read its own state.
   */
  const mode = panelInfo.mode ?? snapshot?.mode ?? 'db'

  const [ssh, setSsh] = React.useState(null)
  const [sshBusy, setSshBusy] = React.useState(false)
  const [sshError, setSshError] = React.useState(null)
  const readSsh = React.useCallback(async () => {
    setSshBusy(true)
    try {
      const json = await hud.fetchJson('/dsh-hud/sql/ssh/state')
      if (!aliveRef.current) return
      setSsh(json)
      setSshError(null)
    } catch (failure) {
      if (aliveRef.current) setSshError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (aliveRef.current) setSshBusy(false)
    }
  }, [])

  /**
   * Ask once, as soon as the card becomes an SSH client.
   *
   * Without this the card sat on "读取中…" until the next poll — a whole minute of a card
   * that looks broken, on the very screen a person switched to on purpose. Asked ONCE (a
   * ref, not state): a failed read must not turn into a retry loop, and the 刷新 button is
   * right there.
   */
  const sshAsked = React.useRef(false)
  React.useEffect(() => {
    if (mode !== 'ssh' || sshAsked.current) return
    sshAsked.current = true
    readSsh().catch(() => {})
  }, [mode, readSsh])

  // The hosts the SETTINGS route knows about, used when the ssh route itself cannot answer
  // — the same fallback the engine list has, for the same reason.
  const settingsHosts = (panelInfo.hosts ?? []).map((one) => ({
    ...one,
    target: `${one.user === undefined || one.user === '' ? '' : `${one.user}@`}${one.host}:${one.port}`,
  }))
  const sshHosts = (ssh?.hosts?.length ?? 0) > 0 ? ssh.hosts : settingsHosts
  const activeHost = ssh?.activeHost ?? panelInfo.activeHost ?? ''

  const sshActions = {
    refresh: () => { readSsh().catch(() => {}) },
    selectHost: (id) => settings.patch({ activeHost: id }),
    copyHost: async (entry) => {
      if (sshHosts.length >= 12) return
      const id = nextHostId(sshHosts)
      const { target: _target, credential: _credential, ...rest } = entry
      const copy = { ...rest, id, name: `${entry.name} ${zh ? '副本' : 'copy'}` }
      const at = sshHosts.findIndex((one) => one.id === entry.id)
      const next = [...sshHosts.slice(0, at + 1), copy, ...sshHosts.slice(at + 1)].map(({ target: _t, credential: _c, ...keep }) => keep)
      await settings.patch({ hosts: next, activeHost: copy.id })
      await readSsh()
    },
    deleteHost: async (entry) => {
      const next = sshHosts
        .filter((one) => one.id !== entry.id)
        .map(({ target: _t, credential: _c, ...keep }) => keep)
      const stillThere = sshHosts.some((one) => one.id === activeHost)
      await settings.patch({ hosts: next, activeHost: stillThere && activeHost !== entry.id ? activeHost : (next[0]?.id ?? '') })
      await readSsh()
    },
    testHost: async (editing, setEditing) => {
      setEditing((current) => (current === null ? current : { ...current, testing: true, outcome: null }))
      try {
        const json = await hud.fetchJson('/dsh-hud/sql/ssh/test', {
          method: 'POST',
          body: JSON.stringify({ host: editing.draft, password: String(editing.draft.password ?? '') }),
        })
        if (!aliveRef.current) return
        setEditing((current) => (current === null ? current : {
          ...current,
          testing: false,
          tested: json?.ok === true,
          outcome: json?.ok === true
            ? { ok: true, text: [zh ? '测试通过' : 'ok', json.target, json.answered, json.ms === undefined ? '' : `${json.ms}ms`].filter((part) => typeof part === 'string' && part !== '').join(' · ') }
            : { ok: false, text: json?.error ?? (zh ? '连不上' : 'failed') },
        }))
      } catch (failure) {
        if (aliveRef.current) {
          setEditing((current) => (current === null ? current : {
            ...current, testing: false, tested: false,
            outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
          }))
        }
      }
    },
    saveHost: async (editing, setEditing) => {
      setEditing((current) => (current === null ? current : { ...current, saving: true }))
      try {
        const pending = editing.draft
        const typed = typeof pending.password === 'string' ? pending.password : ''
        const id = editing.mode === 'edit' ? String(pending.id) : nextHostId(sshHosts)
        let passwordRef = String(pending.passwordRef ?? '').trim()
        if (typed !== '') {
          // Underscores only: the credential store's refs match /^[A-Za-z_][A-Za-z0-9_]*$/, and
          // a hyphen there stops the credentials plugin from loading at all.
          if (passwordRef === '') passwordRef = `dsh_hud_ssh_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
          const stored = await hud.fetchJson('/dsh-hud/sql/credential', {
            method: 'POST',
            body: JSON.stringify({ ref: passwordRef, value: typed }),
          })
          if (!aliveRef.current) return
          if (stored?.ok !== true) {
            setEditing((current) => (current === null ? current : {
              ...current, saving: false, outcome: { ok: false, text: stored?.error ?? (zh ? '密码没能存进凭据库' : 'could not store the password') },
            }))
            return
          }
        }
        const { password: _typed, target: _target, credential: _credential, ...rest } = pending
        const entry = {
          ...rest,
          id,
          name: String(pending.name ?? '').trim() === '' ? (String(pending.host ?? '').trim() || id) : String(pending.name).trim(),
          port: Number(pending.port) || 22,
          timeoutMs: Number(pending.timeoutMs) || 20_000,
          passwordRef: passwordRef === '' ? undefined : passwordRef,
        }
        const clean = (one) => { const { target: _t, credential: _c, ...keep } = one; return keep }
        const next = editing.mode === 'edit'
          ? sshHosts.map((one) => (one.id === id ? entry : one)).map(clean)
          : [...sshHosts, entry].map(clean)
        await settings.patch({ hosts: next, activeHost: editing.mode === 'edit' && activeHost !== '' ? activeHost : id })
        if (!aliveRef.current) return
        setEditing(null)
        await readSsh()
      } catch (failure) {
        if (aliveRef.current) {
          setEditing((current) => (current === null ? current : {
            ...current, saving: false, outcome: { ok: false, text: failure instanceof Error ? failure.message : String(failure) },
          }))
        }
      }
    },
    run: ({ id, command }) => hud.fetchJson('/dsh-hud/sql/ssh/run', { method: 'POST', body: JSON.stringify({ id, command }) }),
    /**
     * The live terminal. Four calls, and the third one is a poll: the panel's transport to
     * the host is request/response, so "what has the far side printed since cursor N" is
     * asked rather than pushed. At 700 ms it is a terminal to anyone using it.
     */
    openTerm: (id) => hud.fetchJson('/dsh-hud/sql/ssh/open', { method: 'POST', body: JSON.stringify({ id }) }),
    pollTerm: (id, since) => hud.fetchJson('/dsh-hud/sql/ssh/session', { method: 'POST', body: JSON.stringify({ id, since }) }),
    sendTerm: (id, data, cols, rows) => hud.fetchJson('/dsh-hud/sql/ssh/input', { method: 'POST', body: JSON.stringify({ id, data, cols, rows }) }),
    closeTerm: (id) => hud.fetchJson('/dsh-hud/sql/ssh/close', { method: 'POST', body: JSON.stringify({ id }) }),
  }

  const modeSwitch = jsxs('span', { className: 'sq-modes', role: 'group', children: [
    jsx('button', {
      type: 'button', className: `sq-mode${mode !== 'ssh' ? ' is-on' : ''}`, 'data-act': 'mode-db',
      'aria-pressed': mode !== 'ssh' ? 'true' : 'false',
      title: zh ? '这张卡显示数据库' : 'this card is a database',
      onClick: () => settings.patch({ mode: 'db' }),
      children: zh ? '数据库' : 'DB',
    }),
    jsx('button', {
      type: 'button', className: `sq-mode${mode === 'ssh' ? ' is-on' : ''}`, 'data-act': 'mode-ssh',
      'aria-pressed': mode === 'ssh' ? 'true' : 'false',
      title: zh ? '这张卡显示 SSH 客户端（同一时间只有一个）' : 'this card is an SSH client (one at a time)',
      onClick: () => settings.patch({ mode: 'ssh' }),
      children: 'SSH',
    }),
  ] })

  /**
   * THE BRANCH. In SSH mode the database side is not rendered and not polled: `collect` is
   * never called, so a card that is an SSH client does not open a database connection at all.
   */
  if (mode === 'ssh') {
    return jsx(SshCard, { zh, payload: ssh ?? { hosts: settingsHosts, activeHost, capability: undefined }, busy: sshBusy, error: sshError, actions: sshActions, modeSwitch })
  }

  const noState = snapshot === null
  const summary = noState
    ? (error === null ? (zh ? '连接中…' : 'connecting…') : (zh ? `读不到状态：${error}` : `cannot read state: ${error}`))
    : connections.length === 0
      ? (zh ? '还没有连接' : 'no connections')
      : snapshot.error !== undefined
        ? snapshot.error
        : schema === undefined
          ? (zh ? '读取 schema…' : 'reading schema…')
          : `${(schema.schemas ?? []).reduce((sum, one) => sum + (one.objects?.length ?? 0), 0)} ${zh ? '个对象' : 'objects'}`

  return jsxs('div', {
    className: 'sq-root',
    children: [
    jsxs('div', { className: 'sq-head', children: [
      jsx('span', { className: 'sq-title', children: zh ? '数据库' : 'SQL' }),
      jsx('span', { className: 'sq-sub', title: snapshot?.target ?? '', children: summary }),
      jsxs('span', { className: 'sq-right', children: [
        modeSwitch,
        connections.length > 1
          ? jsx('span', { className: 'sq-picks', children: connections.map((entry) => jsx('button', {
              type: 'button',
              className: `sq-pick${entry.id === active ? ' is-on' : ''}`,
              title: entry.target,
              'aria-pressed': entry.id === active ? 'true' : 'false',
              onClick: () => settings.patch({ active: entry.id }),
              children: entry.name,
            }, `head-${entry.id}`)) })
          : null,
        jsx('button', {
          type: 'button',
          className: 'sq-ghost',
          'data-act': 'new',
          // The host stores at most 12 (`cleanProfiles`), so a 13th would be dropped on the
          // way in — and it would be the NEW one that vanished, leaving the click looking
          // like it did nothing. Disabled, with the reason in the tooltip, is the honest
          // version. (Opening the panel to inspect the draft is still allowed.)
          disabled: connecting || drivers.every((driver) => driver.available !== true)
            || (connections.length >= MAX_CONNECTIONS && draft === null),
          title: connections.length >= MAX_CONNECTIONS && draft === null
            ? (zh ? `最多 ${MAX_CONNECTIONS} 个连接：先删掉一个，或在 ⚙ 里管理` : `at most ${MAX_CONNECTIONS} connections`)
            : (zh ? '连接另一个数据库' : 'Connect another database'),
          onClick: () => (draft === null ? openDraft() : setDraft(null)),
          children: draft === null ? (zh ? '＋ 连接' : '+ connect') : (zh ? '收起' : 'close'),
        }),
        jsx('button', {
          type: 'button',
          className: 'sq-ghost',
          'data-act': 'refresh',
          // Disabled with nothing to refresh — but a card that could not READ its state has
          // something to retry, and that is exactly when someone is looking for a way to.
          disabled: busy || (connections.length === 0 && snapshot !== null),
          onClick: async () => {
            setBusy(true)
            await read(true)
            if (aliveRef.current) setBusy(false)
          },
          children: busy ? (zh ? '读取中…' : 'reading…') : (zh ? '刷新' : 'Refresh'),
        }),
        jsx(hud.SettingsGear, {
          open: settingsOpen,
          zh,
          label: zh ? '数据库设置' : 'SQL settings',
          onToggle: () => setSettingsOpen((open) => !open),
        }),
      ] }),
    ] }),

    // ── the connection manager ─────────────────────────────────────────────
    //
    // One row per stored connection, each with its own 改/复制/删除, and a draft editor
    // underneath. This replaced a row of chips followed by a row of ✕ buttons — where
    // the third ✕ belonged to the third chip only by counting — and the shared settings
    // form, which wrote every keystroke straight into the settings file and could only
    // ever edit whichever connection happened to be active.
    settingsOpen
      ? jsxs('div', { className: 'sq-conns', children: [
          noState
            ? jsxs('span', { className: 'sq-note is-warn', 'data-act': 'no-state', role: 'alert', children: [
                zh
                  ? `读不到状态，所以这里看不到连接列表 —— 存好的连接没有被删除：${error ?? ''}`
                  : `cannot read state, so the list cannot be shown — nothing has been deleted: ${error ?? ''}`,
              ] })
            : connections.length === 0
              ? jsx('span', { className: 'sq-note', children: zh
                ? '还没有连接。管道里说的话都算数：先测试，通过了才写进设置。'
                : 'No connections yet. Test first — only a working one is stored.' })
              : null,
          ...connections.map((entry) => jsx(SqlConnectionRow, {
            zh,
            entry,
            drivers,
            active,
            busy: settings.busy,
            full: connections.length >= MAX_CONNECTIONS,
            confirming: confirmId === entry.id,
            dropCredential: dropCredential === true,
            onSelect: (id) => settings.patch({ active: id }),
            onEdit: (one) => startEdit(one),
            onCopy: (one) => copyConnection(one),
            onAskDelete: (id) => {
              setDropCredential(false)
              setConfirmId(id)
            },
            onCancelConfirm: () => setConfirmId(''),
            onDropCredential: (on) => setDropCredential(on === true),
            onDelete: (one) => deleteConnection(one),
          }, `conn-${entry.id}`)),
          jsxs('div', { className: 'sq-connsrow', children: [
            jsx('button', {
              type: 'button',
              className: 'sq-connbtn is-add',
              'data-act': 'conn-new',
              disabled: settings.busy || connections.length >= MAX_CONNECTIONS,
              title: connections.length >= MAX_CONNECTIONS
                ? (zh ? `最多 ${MAX_CONNECTIONS} 个连接` : `at most ${MAX_CONNECTIONS}`)
                : (zh ? '新建一个连接（先测试，再保存）' : 'add a connection (test, then save)'),
              onClick: () => startNew(),
              children: zh ? '＋ 新建连接' : '+ new connection',
            }),
            jsxs('label', { className: 'sq-dfield is-number is-tight', title: zh ? '目录缓存时间' : 'how long a schema listing is reused' , children: [
              jsx('span', { className: 'sq-dlabel', children: zh ? '目录缓存' : 'SCHEMA CACHE' }),
              jsx('input', {
                type: 'number',
                'data-field': 'pollMs',
                min: 5000,
                max: 3600000,
                step: 5000,
                value: String(snapshot?.pollMs ?? 60_000),
                disabled: settings.busy,
                onChange: (event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next >= 5000) settings.patch({ pollMs: next })
                },
              }),
              jsx('span', { className: 'sq-dhint', children: zh ? '毫秒' : 'ms' }),
            ] }),
            jsx('span', { className: 'sq-note', children: noState ? '—' : `${connections.length}/${MAX_CONNECTIONS}` }),
            // The reset the shared form used to offer, kept but made deliberate: it drops
            // EVERY card-managed connection and goes back to whatever the settings page
            // ships, so one click is not enough. (The route itself is driven directly in
            // test-host.mjs; this is only the affordance.)
            resetAsk === true
              ? jsxs('span', { className: 'sq-connconfirm', children: [
                  jsx('span', { className: 'sq-note', children: zh
                    ? `放弃卡片里的 ${connections.length} 个连接，改用设置页的值？`
                    : `Drop the card's ${connections.length} connections and use the settings page?` }),
                  jsx('button', {
                    type: 'button',
                    className: 'sq-connbtn is-danger',
                    'data-act': 'conn-reset-confirm',
                    disabled: settings.busy,
                    onClick: () => {
                      setResetAsk(false)
                      settings.reset()
                    },
                    children: zh ? '恢复' : 'Reset',
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'sq-connbtn',
                    'data-act': 'conn-reset-cancel',
                    disabled: settings.busy,
                    onClick: () => setResetAsk(false),
                    children: zh ? '取消' : 'Cancel',
                  }),
                ] })
              : jsx('button', {
                  type: 'button',
                  className: 'sq-connbtn',
                  'data-act': 'conn-reset',
                  disabled: settings.busy,
                  title: zh ? '放弃卡片里保存的连接，回到插件设置页里的连接列表' : 'drop the card settings and use the settings page again',
                  onClick: () => setResetAsk(true),
                  children: zh ? '恢复为设置页的值' : 'use the settings page',
                }),
          ] }),
        ] })
      : null,
    editing === null
      ? null
      : jsx(SqlConnectionEditor, {
          zh,
          drivers,
          mode: editing.mode,
          draft: editing.draft,
          outcome: editing.outcome,
          testing: editing.testing === true,
          saving: editing.saving === true,
          tested: editing.tested === true,
          onDraft: (patch) => setEditing((current) => (current === null ? current : { ...current, draft: { ...current.draft, ...patch }, tested: false })),
          onDriver: (id) => setEditing((current) => (current === null ? current : { ...current, draft: withDriver(current.draft, id, drivers, zh), tested: false })),
          onTest: () => testEditing(),
          onSave: () => saveEditing(),
          onCancel: () => setEditing(null),
        }),
    // The settings error is the manager's too: a refused write has to be visible next to
    // the list it refused to change, not only in the shell's own banner.
    settings.error === null || settings.error === undefined
      ? null
      : jsx('span', { className: 'sq-err', 'data-act': 'settings-error', role: 'alert', children: settings.error }),

    // A state read that failed is shown WHENEVER it failed, result on screen or not.
    //
    // It used to be hidden while a result was displayed, which meant a card that had stopped
    // being able to read its own state looked perfectly healthy — the rows on screen were
    // simply the last ones it managed to get. Stale data with no warning is worse than a
    // warning next to stale data.
    error !== null && snapshot !== null
      ? jsx('span', { className: 'sq-err', 'data-act': 'state-error', role: 'alert', children: error })
      : null,

    // ── the connection panel ───────────────────────────────────────────────
    // Shown when there is nothing configured — the card's whole job at that point is to
    // ask for a database — or when the user opened it to add another one.
    showConnect
      ? jsx(SqlConnect, {
          zh,
          drivers,
          draft: draft ?? blankConnection(drivers, zh),
          busy: connecting,
          outcome,
          onDraft: (patch) => setDraft((current) => ({
            ...(current ?? blankConnection(drivers, zh)),
            ...patch,
          })),
          onDriver: (id) => setDraft((current) => withDriver(current ?? blankConnection(drivers, zh), id, drivers, zh)),
          onConnect: () => { connect().catch(() => {}) },
          onCancel: () => { setDraft(null); setOutcome(null) },
        })
      : null,

    connections.length === 0
      ? jsx('span', { className: 'sq-note', children: zh
        ? '密码只在上面填一次；连接成功后写进 DSH 凭据库，设置文件里只留一个名字。'
        : 'For a password, give the CREDENTIAL NAME (e.g. pg-main); the value stays in the DSH credential store.' })
      : null,

    // A driver this process cannot use says so, once, at the top — rather than
    // failing at connect time with something that looks like a network problem.
    (snapshot?.drivers ?? []).filter((driver) => driver.available !== true).length > 0
      ? jsx('span', { className: 'sq-note', children: (snapshot.drivers ?? [])
        .filter((driver) => driver.available !== true)
        .map((driver) => `${driver.labelZh ?? driver.label}：${driver.reason}`)
        .join(' · ') })
      : null,

    schema !== undefined && (schema.schemas ?? []).length > 0
      ? jsxs('div', { className: 'sq-tree', children: (schema.schemas ?? []).map((one) => {
        const schemaFolded = folded.schemas.has(one.name)
        return jsxs('div', {
          className: `sq-schema${schemaFolded ? ' is-folded' : ''}`,
          children: [
            // A real BUTTON, not a click handler on the row. A div with an onClick cannot be
            // reached by the keyboard, and it is also what made an earlier version of this
            // untestable — the harness clicked the row and nothing happened. A button is
            // focusable, announces its state through aria-expanded, and is clickable by a test
            // for the same reason it is clickable by a person.
            jsxs('button', {
              type: 'button',
              className: 'sq-schemahead',
              'data-act': 'fold-schema',
              'data-schema': one.name,
              'aria-expanded': !schemaFolded,
              onClick: () => toggleFold('schemas', one.name),
              children: [
                jsx('span', { className: 'sq-twist', 'aria-hidden': true, children: schemaFolded ? '▸' : '▾' }),
                jsx('span', { className: 'sq-schemaname', children: one.name }),
                jsx('span', { className: 'sq-cols', children: String(one.objects?.length ?? 0) }),
                one.file !== undefined && one.file !== ''
                  ? jsx('span', { className: 'sq-file', title: one.file, children: one.file })
                  : null,
              ],
            }),
            one.error !== undefined
              ? jsx('span', { className: 'sq-err', children: one.error })
              : null,
            schemaFolded ? null : (one.objects ?? []).map((object) => {
              const key = `${one.name}.${object.name}`
              const objectFolded = folded.objects.has(key)
              return jsxs('div', {
                className: `sq-obj${objectFolded ? ' is-folded' : ''}`,
                children: [
                  jsxs('button', {
                    type: 'button',
                    className: 'sq-objhead',
                    'data-act': 'fold-object',
                    'data-object': key,
                    'aria-expanded': !objectFolded,
                    onClick: () => toggleFold('objects', key),
                    children: [
                      jsx('span', { className: 'sq-twist', 'aria-hidden': true, children: objectFolded ? '▸' : '▾' }),
                      jsx('span', { className: 'sq-icon', 'aria-hidden': true, children: object.kind === 'view' ? '◫' : object.kind === 'foreign' ? '⇥' : '▤' }),
                      jsx('span', { className: 'sq-objname', title: key, children: object.name }),
                      jsx('span', { className: 'sq-kind', children: object.kind === 'view' ? (zh ? '视图' : 'view') : (zh ? '表' : 'table') }),
                      jsx('span', { className: 'sq-cols', title: zh ? '列数' : 'columns', children: String(object.columns?.length ?? 0) }),
                    ],
                  }),
                  objectFolded ? null : jsx('div', { className: 'sq-collist', children: (object.columns ?? []).map((column) => jsxs('div', {
                    className: 'sq-col',
                    children: [
                      jsx('span', { className: 'sq-colname', title: column.name, children: column.name }),
                      jsx('span', { className: 'sq-coltype', title: column.type, children: column.type }),
                      column.primaryKey ? jsx('span', { className: 'sq-pk', title: zh ? '主键' : 'primary key', children: 'PK' }) : null,
                      column.nullable === false ? jsx('span', { className: 'sq-nn', title: zh ? '非空' : 'not null', children: 'NN' }) : null,
                    ],
                  }, `${key}.${column.name}`)) }),
                ],
              }, key)
            }),
          ],
        }, one.name)
      }) })
      : null,

    connections.length > 0
      ? jsxs('div', { className: 'sq-editor', children: [
          // Which database this box talks to, and the way out of it. Without the name, a card
          // with several connections gives no clue which one a statement will run against —
          // and running `delete` against the wrong database is a bad surprise.
          jsxs('div', { className: 'sq-editorhead', children: [
            jsx('span', { className: 'sq-target', title: active, children: connection?.name ?? active }),
            jsx('span', { className: 'sq-driver', children: drivers.find((one) => one.id === connection?.driver)?.labelZh
              ?? connection?.driver ?? '' }),
            jsxs('span', { className: 'sq-editorright', children: [
              readOnly
                ? jsx('span', { className: 'sq-chip', children: zh ? '只读' : 'read-only' })
                : jsx('span', { className: 'sq-chip is-write', children: zh ? '可写' : 'writable' }),
              jsx('button', {
                type: 'button',
                className: 'sq-mini',
                'data-act': 'disconnect',
                title: zh ? '回到连接界面（连接本身不会被删除）' : 'back to the connect form (the connection is kept)',
                onClick: () => { setDraft(null); setOutcome(null); setResult(null); setError(null) },
                children: zh ? '断开' : 'disconnect',
              }),
            ] }),
          ] }),
          jsx('textarea', {
            className: 'sq-sql',
            ref: boxRef,
            value: sql,
            spellCheck: false,
            rows: 3,
            placeholder: zh ? 'select * from users limit 20' : 'select * from users limit 20',
            'aria-label': zh ? 'SQL 语句' : 'SQL statement',
            // A listbox nobody is told about is a listbox only sighted users have.
            'aria-autocomplete': 'list',
            'aria-expanded': suggest !== null,
            'aria-controls': suggest === null ? undefined : 'sq-suggest',
            onChange: (event) => {
              setSql(event.target.value)
              refreshSuggest(event.target.value, caretOf(event.target, event.target.value))
            },
            onKeyDown: (event) => {
              // Ctrl/Cmd+Enter runs: the one keyboard habit every SQL client shares.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                setSuggest(null)
                run()
                return
              }
              // Ctrl+Space asks for the list even on an empty word — how anyone who has used a
              // completion UI before expects to open one.
              if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                const caret = caretOf(event.target, sql)
                const here = wordAt(sql, caret)
                const items = completionsFor(vocabulary, here.word)
                setSuggest(items.length === 0 ? null : { items, index: 0, ...here })
                return
              }
              if (suggest === null) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setSuggest((current) => (current === null ? null : {
                  ...current,
                  index: (current.index + step + current.items.length) % current.items.length,
                }))
                return
              }
              if (event.key === 'Escape') {
                setSuggest(null)
                return
              }
              // Tab and Enter accept. Enter only while the list is open, so Enter by itself
              // still inserts a newline — this box is for writing SQL, not for one line of it.
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault()
                acceptSuggest(suggest.items[suggest.index])
              }
            },
            // Clicking or arrowing inside the box moves the caret, and the list belongs to the
            // word the caret is in.
            onKeyUp: (event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                refreshSuggest(sql, caretOf(event.target, sql))
              }
            },
            onClick: (event) => refreshSuggest(sql, caretOf(event.target, sql)),
            onBlur: () => setSuggest(null),
          }),
          // ── the completion list ──
          //
          // Under the box and over the run row, only as tall as its candidates: this card sits
          // in a grid cell, so a dropdown that pushed the layout around would move the Run
          // button out from under the pointer mid-keystroke.
          suggest === null
            ? null
            : jsxs('div', {
                className: 'sq-suggest',
                id: 'sq-suggest',
                role: 'listbox',
                'aria-label': zh ? '补全建议' : 'completions',
                children: [
                  ...suggest.items.map((item, index) => jsx('button', {
                    type: 'button',
                    role: 'option',
                    'aria-selected': index === suggest.index,
                    className: `sq-suggest-item${index === suggest.index ? ' is-active' : ''}`,
                    'data-act': 'complete',
                    'data-value': item,
                    // mousedown, not click: the textarea's blur fires first and would close the
                    // list before a click ever landed.
                    onMouseDown: (event) => {
                      event.preventDefault()
                      acceptSuggest(item)
                    },
                    children: item,
                  }, `s${index}-${item}`)),
                  jsx('span', {
                    className: 'sq-suggest-hint',
                    children: zh ? 'Tab 补全 · Esc 关闭' : 'Tab completes · Esc closes',
                  }),
                ],
              }),
          jsxs('div', { className: 'sq-runrow', children: [
            // ── the write switch, then the RUN button, then the hints ──
            //
            // The button comes BEFORE the explanation, because it is the thing people are
            // looking for: the row used to open with a lock chip or a checkbox, push the
            // button to the far right, and put "Ctrl+Enter 执行" in between.
            readOnly
              ? jsx('span', {
                className: 'sq-lock',
                'data-enforced-by': engineReadOnly ? 'engine' : 'plugin',
                title: engineReadOnly
                  ? (zh ? '在连接设置里关掉「只读」才能写' : 'turn off read-only in the connection to write')
                  : (zh ? 'SQL Server 没有只读事务：这条连接由插件拦截写语句，而不是服务器拒绝' : 'SQL Server has no read-only transaction: this plugin blocks writes, the server does not'),
                children: engineReadOnly
                  ? (zh ? '🔒 只读 · 服务器保证' : '🔒 read-only · server')
                  : (zh ? '🔒 只读 · 插件拦截' : '🔒 read-only · plugin'),
              })
              : jsxs('label', { className: 'sq-write', children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: allowWrite,
                    onChange: (event) => setAllowWrite(event.target.checked),
                  }),
                  zh ? '允许写' : 'allow write',
                ] }),
            jsx('button', {
              type: 'button',
              className: 'sq-run',
              'data-act': 'run',
              disabled: running || sql.trim() === '',
              // A write without the tick is refused by the host, so the button says what will
              // happen instead of letting the refusal be the teacher.
              title: !readOnly && allowWrite ? (zh ? '会执行写操作' : 'this may write') : undefined,
              onClick: run,
              children: running ? (zh ? '执行中…' : 'running…') : (zh ? '执行' : 'Run'),
            }),
            jsx('span', { className: 'sq-hint', children: zh ? 'Ctrl+Enter' : 'Ctrl+Enter' }),
          ] }),
        ] })
      : null,

    result === null ? null : jsx(SqlResult, { result, zh }),
    // ── a failure, in the SERVER's own words ──
    //
    // Not a one-line summary: the message, the code, the DETAIL and any HINT the server
    // offered. A card that says only "执行失败" makes people guess, and the guess is usually
    // about their SQL when the real answer is sitting in the DETAIL line.
    queryError !== null && queryError !== undefined
      ? jsxs('div', { className: 'sq-failure', role: 'alert', children: [
          jsxs('div', { className: 'sq-failhead', children: [
            jsx('span', { className: 'sq-failtitle', children: zh ? '执行失败' : 'statement failed' }),
            queryError.code === undefined || queryError.code === ''
              ? null
              : jsx('span', { className: 'sq-failcode', children: String(queryError.code) }),
          ] }),
          // `pre` and not `span`: a server message has newlines in it, and collapsing them
          // into one paragraph is how a stack-like error becomes unreadable.
          jsx('pre', { className: 'sq-failtext', children: queryError.message }),
          queryError.detail === undefined || queryError.detail === ''
            ? null
            : jsxs('div', { className: 'sq-failrow', children: [
                jsx('span', { className: 'sq-faillabel', children: 'DETAIL' }),
                jsx('span', { children: queryError.detail }),
              ] }),
          queryError.hint === undefined || queryError.hint === ''
            ? null
            : jsxs('div', { className: 'sq-failrow', children: [
                jsx('span', { className: 'sq-faillabel', children: 'HINT' }),
                jsx('span', { children: queryError.hint }),
              ] }),
          queryError.position === undefined || queryError.position === ''
            ? null
            : jsxs('div', { className: 'sq-failrow', children: [
                jsx('span', { className: 'sq-faillabel', children: zh ? '位置' : 'POSITION' }),
                jsx('span', { children: String(queryError.position) }),
              ] }),
        ] })
      : null,
  ] })
}

/**
 * The fields ONE driver needs, from the list the host exports.
 *
 * Extracted so the connect panel and the connection editor cannot drift apart: there is
 * one description of what PostgreSQL asks for, and both render it.
 */
function driverFields(driverId, drivers, zh) {
  const spec = drivers.find((one) => one.id === driverId)
  return (spec?.fields ?? [{ key: 'file', label: '数据库文件', labelEn: 'FILE', kind: 'text' }]).map((field) => ({
    kind: field.kind === 'number' ? 'number' : field.kind === 'toggle' ? 'toggle' : 'text',
    key: field.key,
    label: zh ? field.label : (field.labelEn ?? field.label),
    placeholder: field.placeholder,
    min: field.kind === 'number' ? 1 : undefined,
    max: field.kind === 'number' ? 65_535 : undefined,
    hint: field.key === 'passwordRef'
      ? (zh ? '只写凭据的名字，值从 DSH 凭据库读，不存进设置文件。' : 'The credential NAME only; the value stays in the credential store.')
      : undefined,
  }))
}

/** Which fields a driver's connection needs — from the ONE list the host exports. */
function createSqlPanel() {
  const CSS_ID = 'dsh-hud/sql.css'
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-hud'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = [
      '.sq-root{display:flex;flex-direction:column;gap:8px;min-width:0;font-variant-numeric:tabular-nums}',
      '.sq-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px}',
      '.sq-title{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-sub{margin-left:2px;color:var(--dsw-alias-label-caption,#81858c);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42%}',
      '.sq-right{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none}',
      '.sq-ghost{padding:0 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-ghost:hover{border-color:var(--hud-line-2,rgba(0,0,0,.18))}',
      '.sq-ghost:disabled{opacity:.4;cursor:default}',
      '.sq-picks{display:inline-flex;gap:4px;flex-wrap:wrap}',
      // NOT a native `<select>`: the suite forbids one in this panel (and it is right
      // to — a native dropdown cannot be themed to match the card, and it was caught
      // by exactly that assertion).
      '.sq-pick{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-pick.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.sq-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#81858c);word-break:break-word}',
      '.sq-note.is-warn{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // The SSH half: the mode switch, the command box, and the output block.
      '.sq-modes{display:inline-flex;gap:0;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;overflow:hidden}',
      '.sq-mode{padding:0 9px;border:0;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-mode.is-on{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}',
      '.sq-sshrun{display:flex;flex-direction:column;gap:6px}',
      '.sq-sshcmd{flex:1 1 auto;min-width:0;padding:4px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:7px;background:transparent;font-family:inherit;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-sshpresets{display:flex;flex-wrap:wrap;gap:5px}',
      '.sq-sshout{display:flex;flex-direction:column;gap:4px}',
      '.sq-sshmeta{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-sshmeta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-exit{font-variant-numeric:tabular-nums}',
      '.sq-exit.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sq-exit.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-sshstdout,.sq-sshstderr{margin:0;padding:7px 9px;border-radius:7px;max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;scrollbar-width:thin}',
      '.sq-sshstdout{background:var(--hud-tile,rgba(0,0,0,.035));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-sshstderr{background:rgba(220,38,38,.06);color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      // The live terminal: a real grid, so the styling is monospace and nothing else.
      '.sq-term{display:flex;flex-direction:column;gap:5px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;padding:6px;background:var(--hud-tile,rgba(0,0,0,.02))}',
      '.sq-termbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.sq-termdot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16a34a);flex:0 0 auto}',
      '.sq-termdot.is-off{background:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-termtarget{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-termspace{flex:1 1 auto}',
      '.sq-termkey{padding:0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}',
      '.sq-termscroll{margin:0;max-height:120px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:15px;white-space:pre;color:var(--dsw-alias-label-caption,#81858c);scrollbar-width:thin}',
      '.sq-termscreen{margin:0;padding:6px 7px;border-radius:6px;background:var(--hud-term-bg,rgba(0,0,0,.055));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:15px;white-space:pre;overflow-x:auto;cursor:text;scrollbar-width:thin}',
      '.sq-termrow{min-height:15px}',
      '.sq-termrun.is-bold{font-weight:700}',
      '.sq-termrun.is-dim{opacity:.65}',
      '.sq-termrun.fg-black{color:#1f2328}.sq-termrun.fg-red{color:#c02b2b}.sq-termrun.fg-green{color:#137a3a}',
      '.sq-termrun.fg-yellow{color:#8a6100}.sq-termrun.fg-blue{color:#2b5fd9}.sq-termrun.fg-magenta{color:#9b2fa8}',
      '.sq-termrun.fg-cyan{color:#0d7b86}.sq-termrun.fg-white{color:#6b7280}',
      '.sq-termrun.fg-black-bright{color:#4b5563}.sq-termrun.fg-red-bright{color:#e5484d}.sq-termrun.fg-green-bright{color:#22a06b}',
      '.sq-termrun.fg-yellow-bright{color:#b7791f}.sq-termrun.fg-blue-bright{color:#4a7dff}.sq-termrun.fg-magenta-bright{color:#c05bd6}',
      '.sq-termrun.fg-cyan-bright{color:#12a3b0}.sq-termrun.fg-white-bright{color:#9aa1ab}',
      '.sq-termrun.bg-black{background:rgba(31,35,40,.85);color:#f6f7f9}.sq-termrun.bg-red{background:rgba(192,43,43,.14)}',
      '.sq-termrun.bg-green{background:rgba(19,122,58,.14)}.sq-termrun.bg-yellow{background:rgba(138,97,0,.16)}',
      '.sq-termrun.bg-blue{background:rgba(43,95,217,.14)}.sq-termrun.bg-magenta{background:rgba(155,47,168,.14)}',
      '.sq-termrun.bg-cyan{background:rgba(13,123,134,.14)}.sq-termrun.bg-white{background:rgba(0,0,0,.07)}',
      '.sq-termline{display:flex;gap:5px;align-items:center}',
      '.sq-terminput{flex:1 1 auto;min-width:0;padding:4px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:7px;background:transparent;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-err{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#dc2626);word-break:break-word}',
      '.sq-code{display:block;margin-top:4px;padding:7px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:15px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#61666b)}',
      // ── connecting: engine → parameters → connect ──
      '.sq-connect{display:flex;flex-direction:column;gap:9px;padding:9px 10px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}',
      '.sq-connect-head{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-dtypes{display:flex;flex-wrap:wrap;gap:6px}',
      '.sq-dtype{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:inherit;cursor:pointer}',
      '.sq-dtype.is-on{border-color:var(--dsw-alias-brand-primary,#3964fe);background:rgba(57,100,254,.10);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-dtype:disabled{opacity:.4;cursor:default}',
      '.sq-dtype em{font-style:normal;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.75}',
      // The parameters change with the engine, so they are laid out as a grid that can
      // hold four short fields in two rows on a narrow card.
      '.sq-dfields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px 9px}',
      '.sq-dfield{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.sq-dlabel{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-dfield input{box-sizing:border-box;width:100%;min-width:0;padding:4px 7px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);font-family:inherit;font-size:11.5px;line-height:17px;color:inherit}',
      '.sq-dfield.is-toggle{flex-direction:row;align-items:center;gap:7px}',
      '.sq-dfield.is-toggle input{width:auto}',
      '.sq-dhint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);word-break:break-word}',
      '.sq-dorun{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      // The accent is written out rather than taken from --dsw-alias-brand-primary: that token is
      // a BORDER/text colour in this design system, and using it as a fill produced a grey pill
      // with grey text. The value below is the same one the shell uses for its own filled
      // controls (the pressed ⚙, the layout thumb).
      '.sq-connect-go{padding:3px 14px;border:1px solid transparent;border-radius:999px;background:#3964fe;font-family:inherit;font-size:11.5px;line-height:18px;font-weight:500;color:#fff;cursor:pointer}',
      '.sq-connect-go:hover:not(:disabled){background:#2f55e0}',
      '.sq-connect-go:disabled{opacity:.5;cursor:default}',
      '.sq-connect-cancel{padding:3px 10px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:18px;color:inherit;cursor:pointer}',
      '.sq-outcome{font-size:11px;line-height:16px;word-break:break-word}',
      '.sq-outcome.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sq-outcome.is-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // ── the tree ──
      '.sq-tree{display:flex;flex-direction:column;gap:5px;max-height:180px;overflow-y:auto;scrollbar-width:thin}',
      '.sq-schema{display:flex;flex-direction:column;gap:2px}',
      '.sq-schemahead{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-file{font-weight:400;letter-spacing:0;text-transform:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%;opacity:.8}',
      '.sq-obj{display:flex;flex-direction:column}',
      '.sq-objhead{display:flex;align-items:center;gap:6px;width:100%;padding:1px 4px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary,#0f1115);text-align:left}',
      '.sq-icon{width:12px;flex:none;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-objname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-kind{margin-left:auto;flex:none;font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-cols{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-collist{display:flex;flex-direction:column;gap:1px;padding:1px 0 3px 18px}',
      '.sq-col{display:flex;align-items:baseline;gap:6px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-colname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-coltype{margin-left:auto;font-size:9.5px;color:var(--dsw-alias-label-caption,#81858c);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.sq-pk,.sq-nn{flex:none;padding:0 4px;border-radius:3px;font-size:9px;line-height:13px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-pk{background:rgba(57,100,254,.12);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      // ── the editor ──
      // ── the connected view: which database, and the way out ──
      '.sq-editorhead{display:flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;line-height:17px}',
      // ── the tree: two buttons, not two divs ──
      //
      // Both headers were plain divs with text in them. They are buttons now so the fold is
      // reachable by keyboard and announceable (aria-expanded), and so a click lands on a real
      // control — an earlier version put the handler on the row and nothing reached it.
      '.sq-schemahead,.sq-objhead{display:flex;align-items:center;gap:6px;width:100%;padding:2px 4px;border:0;border-radius:5px;background:transparent;font-family:inherit;font-size:11.5px;line-height:17px;color:inherit;text-align:left;cursor:pointer}',
      '.sq-schemahead:hover,.sq-objhead:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
      '.sq-schemahead:focus-visible,.sq-objhead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-1px}',
      '.sq-twist{flex:none;width:9px;font-size:9px;line-height:1;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-obj.is-folded .sq-objhead,.sq-schema.is-folded .sq-schemahead{opacity:.82}',
      // ── the completer ──
      //
      // In the flow, under the box: a positioned popup would be clipped by the card, and this
      // card is a grid cell with `overflow` on its body.
      '.sq-suggest{display:flex;flex-direction:column;gap:1px;margin-top:-4px;padding:4px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 6px 16px rgba(0,0,0,.10);max-height:168px;overflow-y:auto}',
      '.sq-suggest-item{display:block;width:100%;padding:2px 7px;border:0;border-radius:5px;background:transparent;font-family:var(--hud-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:inherit;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sq-suggest-item.is-active{background:rgba(57,100,254,.14);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-suggest-hint{padding:1px 7px 0;font-size:9.5px;letter-spacing:.03em;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-target{font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sq-driver{flex:none;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-editorright{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none}',
      '.sq-mini{padding:1px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.12));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-mini:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22));color:var(--dsw-alias-label-primary,#0f1115)}',
      // The RUN button leads the row: it is what people look for first. The write switch and
      // the keyboard hint come after it.
      '.sq-run{padding:3px 16px;border:1px solid transparent;border-radius:999px;background:#3964fe;font-family:inherit;font-size:11.5px;line-height:18px;font-weight:500;color:#fff;cursor:pointer}',
      '.sq-run:hover:not(:disabled){background:#2f55e0}',
      '.sq-run:disabled{opacity:.45;cursor:default}',
      '.sq-kbd{font-size:10px;color:var(--dsw-alias-label-caption,#81858c)}',
      // ── the failure block ──
      //
      // A server message is a paragraph with newlines in it, so it is rendered in a `pre` that
      // WRAPS: a horizontal scrollbar for an error message hides the end of the sentence, which
      // is usually the useful part.
      '.sq-failure{display:flex;flex-direction:column;gap:5px;padding:8px 9px;border:1px solid rgba(220,38,38,.35);border-radius:8px;background:rgba(220,38,38,.06)}',
      '.sq-failhead{display:flex;align-items:center;gap:7px;font-size:11.5px;line-height:16px}',
      '.sq-failtitle{font-weight:600;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-failcode{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(220,38,38,.14);color:var(--dsw-alias-state-error-primary,#dc2626);font-variant-numeric:tabular-nums}',
      '.sq-failtext{margin:0;font-family:inherit;font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-failrow{display:flex;gap:7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-faillabel{flex:none;font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-caption,#81858c);padding-top:1px}',
      '.sq-restitle.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sq-affected{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-editor{display:flex;flex-direction:column;gap:5px}',
      '.sq-sql{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary,#0f1115);resize:vertical}',
      '.sq-sql:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-runrow{display:flex;align-items:center;gap:8px;font-size:10.5px}',
      '.sq-write{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.sq-lock{color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-spacer{margin-left:auto}',
      '.sq-hint{color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-run{padding:0 12px;border:1px solid rgba(57,100,254,.35);border-radius:999px;background:rgba(57,100,254,.10);font-family:inherit;font-size:11px;line-height:19px;font-weight:600;color:var(--dsw-alias-state-business-primary,#3964fe);cursor:pointer}',
      '.sq-run:disabled{opacity:.45;cursor:default}',
      // ── the result ──
      '.sq-result{display:flex;flex-direction:column;gap:5px}',
      '.sq-reshead{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-caption,#81858c)}',
      '.sq-restitle{font-weight:600;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.sq-ms{margin-left:auto}',
      '.sq-chip{padding:0 6px;border-radius:999px;border:1px solid var(--hud-line,rgba(0,0,0,.1));font-size:9.5px;line-height:15px}',
      '.sq-chip.is-write{border-color:rgba(245,158,11,.45);color:var(--dsw-alias-state-warn-primary,#b45309);background:rgba(245,158,11,.12)}',
      '.sq-notice{font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-scroll{max-height:220px;overflow:auto;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:7px;scrollbar-width:thin}',
      '.sq-table{border-collapse:collapse;width:100%;font-size:11px;line-height:16px}',
      '.sq-table th{position:sticky;top:0;padding:3px 8px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.1));background:var(--hud-tile,var(--dsw-alias-bg-layer-1,#fff));text-align:left;font-weight:600;white-space:nowrap;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.sq-table td{padding:2px 8px;border-bottom:1px solid var(--hud-line,rgba(0,0,0,.05));white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-table tr:last-child td{border-bottom:0}',
      '.sq-null{color:var(--dsw-alias-label-caption,#81858c);font-style:italic}',
      '.sq-empty{padding:8px;text-align:center;color:var(--dsw-alias-label-caption,#81858c)}',
      // The connection manager: one row per stored connection, each with its own actions.
      //
      // It used to be a row of chips followed by a row of ✕ buttons — which meant the third
      // ✕ belonged to the third chip only by counting. A row cannot be miscounted.
      '.sq-conns{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}',
      '.sq-connrow{display:flex;align-items:center;gap:7px;padding:4px 6px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:8px;min-width:0;flex-wrap:wrap}',
      '.sq-connrow.is-on{border-color:rgba(57,100,254,.35);background:rgba(57,100,254,.07)}',
      '.sq-connrow.is-confirming{border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.05)}',
      '.sq-connpick{display:flex;flex-direction:column;align-items:flex-start;gap:1px;flex:1 1 auto;min-width:0;padding:1px 2px;border:0;background:transparent;font-family:inherit;text-align:left;cursor:pointer}',
      '.sq-connname{font-size:11.5px;font-weight:600;line-height:15px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.sq-connrow.is-on .sq-connname{color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.sq-conntarget{font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.sq-connmeta{display:inline-flex;align-items:center;gap:4px;flex:none;flex-wrap:wrap;justify-content:flex-end}',
      '.sq-tag{padding:0 5px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;font-style:normal;font-size:9.5px;line-height:15px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}',
      '.sq-tag.is-write{border-color:rgba(217,161,59,.45);color:#a1770f}',
      '.sq-tag.is-warn{border-color:rgba(220,38,38,.4);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-connactions,.sq-connconfirm{display:inline-flex;align-items:center;gap:4px;flex:none}',
      // The confirmation takes its OWN line: it carries a question, a checkbox and two
      // buttons, and sharing a line with the connection's name is how the last button ends
      // up clipped at the card's edge — measured in a 480px harness, not guessed.
      '.sq-connconfirm{flex:1 1 100%;flex-wrap:wrap;justify-content:flex-end;padding-top:2px}',
      '.sq-connbtn{padding:0 7px;border:1px solid var(--hud-line,rgba(0,0,0,.1));border-radius:999px;background:transparent;font-family:inherit;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap}',
      '.sq-connbtn:hover:not(:disabled){border-color:var(--hud-line-2,rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.sq-connbtn:disabled{opacity:.4;cursor:default}',
      '.sq-connbtn.is-danger:hover:not(:disabled){border-color:rgba(220,38,38,.45);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sq-connbtn.is-add{border-style:dashed}',
      '.sq-connsrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.sq-dfield.is-tight{flex-direction:row;align-items:center;gap:5px}',
      '.sq-dfield.is-tight input{width:auto;min-width:0;max-width:110px}',
      '.sq-editor{display:flex;flex-direction:column;gap:9px;margin-bottom:6px;padding:9px 10px;border:1px solid rgba(57,100,254,.3);border-radius:8px;background:rgba(57,100,254,.04)}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  return {
    id: 'sql',
    // 25: packed THIRD — after 用量限额 (20) and before 快递 (30).
    //
    // The order is the geometry, and this one is load-bearing: the packer fills the topmost
    // hole first, so if this card were packed after 快递 it would land at the top of column 3
    // and 快递 would take the middle hole instead. Being third is what puts 数据库 in the right
    // column and leaves the middle free for the stack under 用量限额.
    order: 25,
    label: { zh: '数据库', en: 'SQL' },
    // One column: the third column of the shipped layout. The schema tree and the result grid
    // stack instead of sitting side by side — and ⚙ can widen it to two columns for anyone who
    // wants them beside each other.
    span: 1,
    // ON by default: it is part of the shipped layout, and it opens with the connection form
    // rather than with a paragraph telling you to find the gear.
    defaultOn: true,
    /**
     * Five rows — the full height of the arrangement.
     *
     * A connection form, a schema tree and a result grid need the room, and it is also
     * arithmetic: the middle column is 4 + 3 + 3, so this card has to be 10 for the three
     * columns to end on the same row.
     */
    defaultRows: 5,
    Component: SqlCard,
  }
}