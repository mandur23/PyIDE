// Compact schemas for well-known YAML files: GitHub Actions workflows (.github/workflows/*.yml) and Docker Compose
// files (compose.yaml, docker-compose.yml…). Mappings listed as closed report keys they do not have; values are checked
// only against enums and patterns, and ${{ }} expressions are never checked.
(() => {
  const df = ide.dataFormats;
  const { ANY, str, int, bool, en, obj, closed, map, arr, strs, any } = df.schema;
  const STRING = { type: 'string' };
  const SCALAR = { type: ['string', 'number', 'boolean'] };
  const strOrList = (d, x) => any(d, { type: 'string', ...x }, arr(null, { type: 'string', ...x }));
  // Booleans and numbers in workflows may also be ${{ }} expressions.
  const boolOrExpr = (d, dflt) => def(d, { type: ['boolean', 'string'], ...(dflt !== undefined && { default: dflt }) });
  const numOrExpr = (d) => def(d, { type: ['number', 'string'] });
  function def(description, x) { return description ? { description, ...x } : x; }

  // ---------- GitHub Actions ----------
  const filters = {
    branches: strs(tr('Branch name patterns (glob) the event is limited to.')),
    'branches-ignore': strs(tr('Branch name patterns (glob) the event ignores.')),
    tags: strs(tr('Tag name patterns (glob) the event is limited to.')),
    'tags-ignore': strs(tr('Tag name patterns (glob) the event ignores.')),
    paths: strs(tr('File path patterns (glob): the workflow runs only when a matching file changed.')),
    'paths-ignore': strs(tr('File path patterns (glob): the workflow does not run when only matching files changed.')),
  };
  const activity = (values) => ({ types: strOrList(tr('Activity types that trigger the workflow.'), values ? { enum: values } : {}) });
  const event = (name, props = activity()) => closed(tr('Runs the workflow on the {event} event.', { event: name }), props);
  const INPUT_TYPES = ['string', 'boolean', 'choice', 'number', 'environment'];
  const input = (types) => closed(null, {
    description: str(tr('What the input is for.')),
    required: bool(tr('Whether the input must be given.'), false),
    default: SCALAR,
    type: en(tr('The type of the input.'), types),
    options: strs(tr('The choices of a choice input.')),
    deprecationMessage: STRING,
  });
  const EVENTS = {
    push: closed(tr('Runs the workflow when commits or tags are pushed.'), { branches: filters.branches, 'branches-ignore': filters['branches-ignore'],
      tags: filters.tags, 'tags-ignore': filters['tags-ignore'], paths: filters.paths, 'paths-ignore': filters['paths-ignore'] }),
    pull_request: closed(tr('Runs the workflow on pull request activity (by default when one is opened, synchronized or reopened).'), {
      ...activity(['assigned', 'unassigned', 'labeled', 'unlabeled', 'opened', 'edited', 'closed', 'reopened', 'synchronize', 'converted_to_draft',
        'ready_for_review', 'locked', 'unlocked', 'review_requested', 'review_request_removed', 'auto_merge_enabled', 'auto_merge_disabled',
        'milestoned', 'demilestoned', 'enqueued', 'dequeued']),
      branches: filters.branches, 'branches-ignore': filters['branches-ignore'], paths: filters.paths, 'paths-ignore': filters['paths-ignore'] }),
    workflow_dispatch: closed(tr('Lets the workflow be run by hand, from the Actions tab or the API.'), {
      inputs: map(tr('Inputs asked for when the workflow is run by hand.'), input(INPUT_TYPES)) }),
    workflow_call: closed(tr('Lets other workflows call this one (a reusable workflow).'), {
      inputs: map(tr('Inputs the calling workflow passes.'), input(['boolean', 'number', 'string'])),
      outputs: map(tr('Outputs returned to the calling workflow.'), closed(null, { description: STRING, value: str(tr('The output value, usually an expression.')) })),
      secrets: map(tr('Secrets the calling workflow passes.'), any(null, { type: 'null' }, closed(null, { description: STRING, required: { type: 'boolean' } }))),
    }),
    schedule: arr(tr('Runs the workflow at scheduled times (UTC, cron syntax).'), closed(null, { cron: str(tr('A cron expression, such as "30 5 * * 1-5".')) })),
    release: event('release', activity(['published', 'unpublished', 'created', 'edited', 'deleted', 'prereleased', 'released'])),
    issues: event('issues', activity(['opened', 'edited', 'deleted', 'transferred', 'pinned', 'unpinned', 'closed', 'reopened', 'assigned', 'unassigned',
      'labeled', 'unlabeled', 'locked', 'unlocked', 'milestoned', 'demilestoned', 'typed', 'untyped'])),
    workflow_run: closed(tr('Runs the workflow when another workflow is requested or completed.'), {
      workflows: strs(tr('The names of the workflows.')),
      ...activity(['completed', 'requested', 'in_progress']),
      branches: filters.branches, 'branches-ignore': filters['branches-ignore'] }),
    pull_request_target: closed(tr('Runs the workflow on pull request activity, in the context of the base branch.'), {
      ...activity(), branches: filters.branches, 'branches-ignore': filters['branches-ignore'], paths: filters.paths, 'paths-ignore': filters['paths-ignore'] }),
    repository_dispatch: event('repository_dispatch'),
    merge_group: event('merge_group', { ...activity(['checks_requested']), branches: filters.branches, 'branches-ignore': filters['branches-ignore'] }),
  };
  for (const name of ['branch_protection_rule', 'check_run', 'check_suite', 'create', 'delete', 'deployment', 'deployment_status', 'discussion',
    'discussion_comment', 'fork', 'gollum', 'issue_comment', 'label', 'milestone', 'page_build', 'public', 'pull_request_review',
    'pull_request_review_comment', 'registry_package', 'status', 'watch']) EVENTS[name] = event(name);
  const on = any(tr('The events that run the workflow: one event, a list, or events with their filters.'),
    { enum: Object.keys(EVENTS) }, arr(null, { enum: Object.keys(EVENTS) }), closed(null, EVENTS));

  const SCOPES = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues', 'models', 'packages', 'pages',
    'pull-requests', 'repository-projects', 'security-events', 'statuses'];
  const permissions = any(tr('The permissions of the GITHUB_TOKEN: read-all, write-all, or a level per scope.'),
    { enum: ['read-all', 'write-all'] }, { type: 'object', properties: Object.fromEntries(SCOPES.map((s) => [s, { enum: ['read', 'write', 'none'] }])), additionalProperties: false });
  const env = map(tr('Environment variables.'), SCALAR);
  const concurrency = any(tr('Runs at most one workflow or job of the same concurrency group at a time.'), STRING, closed(null, {
    group: str(tr('The name of the concurrency group.')),
    'cancel-in-progress': boolOrExpr(tr('Cancels the run in progress of the group when a new one starts.'), false),
  }));
  const defaults = closed(tr('Defaults for the run steps.'), { run: closed(null, {
    shell: str(tr('The shell that runs the commands.'), { examples: ['bash', 'pwsh', 'python', 'sh', 'cmd', 'powershell'] }),
    'working-directory': str(tr('The folder the commands run in.')),
  }) });
  const container = (d) => any(d, STRING, closed(null, {
    image: str(tr('The Docker image.')),
    credentials: closed(null, { username: STRING, password: STRING }),
    env,
    ports: arr(null, { type: ['string', 'number'] }),
    volumes: strs(),
    options: str(tr('More docker create options.')),
  }));
  const step = closed(null, {
    id: str(tr('An identifier for the step, to refer to its outputs (steps.<id>.outputs).')),
    if: str(tr('Runs the step only when the condition (an expression) is true.')),
    name: str(tr('The name of the step, shown in the log.')),
    uses: str(tr('The action to run: owner/repo@ref, ./path or docker://image.'), {
      examples: ['actions/checkout@v4', 'actions/setup-python@v5', 'actions/setup-node@v4', 'actions/setup-java@v4', 'actions/cache@v4',
        'actions/upload-artifact@v4', 'actions/download-artifact@v4'] }),
    run: str(tr('Commands to run in the shell.')),
    shell: str(tr('The shell that runs the commands.'), { examples: ['bash', 'pwsh', 'python', 'sh', 'cmd', 'powershell'] }),
    with: map(tr('Inputs of the action.'), SCALAR),
    env,
    'continue-on-error': boolOrExpr(tr('Lets the job go on when the step fails.'), false),
    'timeout-minutes': numOrExpr(tr('Minutes the step may run before it is cancelled.')),
    'working-directory': str(tr('The folder the commands run in.')),
  });
  const job = closed(null, {
    name: str(tr('The name of the job, shown on GitHub.')),
    'runs-on': any(tr('The machine the job runs on: a runner label, a list of labels, or a group.'),
      { type: 'string', examples: ['ubuntu-latest', 'windows-latest', 'macos-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'self-hosted'] },
      arr(null, STRING), closed(null, { group: STRING, labels: strOrList() })),
    needs: strOrList(tr('Jobs that must finish successfully before this one starts.')),
    if: str(tr('Runs the job only when the condition (an expression) is true.')),
    permissions,
    environment: any(tr('The deployment environment of the job.'), STRING, closed(null, { name: STRING, url: STRING, deployment: { type: ['boolean', 'string'] } })),
    concurrency,
    outputs: map(tr('Outputs of the job, for jobs that need it.'), STRING),
    env,
    defaults,
    steps: arr(tr('The steps of the job, run in order.'), step),
    'timeout-minutes': numOrExpr(tr('Minutes the job may run before it is cancelled (360 when not set).')),
    strategy: closed(tr('A matrix of job variations.'), {
      matrix: any(tr('Variables whose combinations each run the job once.'), STRING, obj(null, {
        include: arr(tr('Combinations to add, or variables to add to matching combinations.'), map(null, ANY)),
        exclude: arr(tr('Combinations to leave out.'), map(null, ANY)),
      }, { additionalProperties: ANY })),
      'fail-fast': boolOrExpr(tr('Cancels the other jobs of the matrix when one fails.'), true),
      'max-parallel': numOrExpr(tr('How many jobs of the matrix may run at the same time.')),
    }),
    'continue-on-error': boolOrExpr(tr('Lets the workflow go on when the job fails.'), false),
    container: container(tr('A container the steps of the job run in.')),
    services: map(tr('Service containers for the job (databases, caches…).'), container()),
    uses: str(tr('A reusable workflow to run as this job: owner/repo/.github/workflows/file.yml@ref or ./.github/workflows/file.yml.')),
    with: map(tr('Inputs of the reusable workflow.'), SCALAR),
    secrets: any(tr('Secrets passed to the reusable workflow, or inherit.'), { enum: ['inherit'] }, map(null, STRING)),
  });
  const workflow = closed(null, {
    name: str(tr('The name of the workflow, shown in the Actions tab.')),
    'run-name': str(tr('The name of the workflow runs (may use expressions).')),
    on,
    permissions,
    env,
    defaults,
    concurrency,
    jobs: map(tr('The jobs of the workflow, by job ID. They run in parallel unless needs orders them.'), job),
  });
  df.addYamlSchema((p) => /\/\.github\/workflows\/[^/]+\.ya?ml$/i.test(p), workflow);

  // ---------- Docker Compose ----------
  const X = { '^x-': ANY }; // extension keys are allowed anywhere
  const cl = (d, props) => closed(d, props, { patternProperties: X });
  const listOrMap = (d) => any(d, map(null, { type: ['string', 'number', 'boolean', 'null'] }), strs());
  const duration = (d) => str(d);
  const RESTART = ['no', 'always', 'on-failure', 'unless-stopped'];
  const service = cl(null, {
    image: str(tr('The image to start the container from (name:tag or a digest).')),
    build: any(tr('How to build the image: the build context folder, or build options.'), STRING, cl(null, {
      context: str(tr('The folder (or Git URL) sent to the builder.')),
      dockerfile: str(tr('The Dockerfile, relative to the context.'), { default: 'Dockerfile' }),
      dockerfile_inline: str(tr('The Dockerfile itself, written here.')),
      args: listOrMap(tr('Build arguments (ARG).')),
      target: str(tr('The stage of a multi-stage Dockerfile to build.')),
      cache_from: strs(), cache_to: strs(), labels: listOrMap(), network: STRING, shm_size: { type: ['string', 'number'] },
      ssh: any(null, STRING, arr(null, STRING), map(null, STRING)), secrets: arr(null, ANY), platforms: strs(), tags: strs(),
      additional_contexts: listOrMap(), extra_hosts: listOrMap(), no_cache: { type: 'boolean' }, pull: { type: 'boolean' },
      privileged: { type: 'boolean' }, isolation: STRING, entitlements: strs(), ulimits: map(null, ANY),
    })),
    command: any(tr('Overrides the command of the image.'), STRING, arr(null, STRING), { type: 'null' }),
    entrypoint: any(tr('Overrides the entry point of the image.'), STRING, arr(null, STRING), { type: 'null' }),
    container_name: str(tr('A fixed container name instead of a generated one.')),
    ports: arr(tr('Ports to publish: "host:container", or the long form.'), any(null, { type: ['string', 'number'] }, cl(null, {
      target: { type: ['number', 'string'] }, published: { type: ['string', 'number'] }, host_ip: STRING,
      protocol: en(null, ['tcp', 'udp']), mode: en(null, ['host', 'ingress']), name: STRING, app_protocol: STRING,
    }))),
    expose: arr(tr('Ports open to other services only, not published to the host.'), { type: ['string', 'number'] }),
    volumes: arr(tr('Volumes and host folders to mount: "source:target[:mode]", or the long form.'), any(null, STRING, cl(null, {
      type: en(null, ['bind', 'volume', 'tmpfs', 'npipe', 'cluster', 'image']), source: STRING, target: STRING, read_only: { type: 'boolean' },
      consistency: STRING, bind: obj(null, {}), volume: obj(null, {}), tmpfs: obj(null, {}), image: obj(null, {}),
    }))),
    volumes_from: strs(),
    environment: listOrMap(tr('Environment variables: a map, or a list of NAME=value.')),
    env_file: any(tr('Files with environment variables.'), STRING, arr(null, any(null, STRING, closed(null, { path: STRING, required: { type: 'boolean' }, format: STRING })))),
    depends_on: any(tr('Services to start before this one: a list, or services with a condition.'), arr(null, STRING), map(null, cl(null, {
      condition: en(tr('When the dependency counts as ready.'), ['service_started', 'service_healthy', 'service_completed_successfully'], { default: 'service_started' }),
      restart: { type: 'boolean' },
      required: { type: 'boolean' },
    }))),
    networks: any(tr('Networks the service joins.'), arr(null, STRING), map(null, any(null, { type: 'null' }, cl(null, {
      aliases: strs(), ipv4_address: STRING, ipv6_address: STRING, link_local_ips: strs(), mac_address: STRING,
      driver_opts: map(null, ANY), priority: { type: 'number' }, gw_priority: { type: 'number' }, interface_name: STRING,
    })))),
    network_mode: str(tr('The network mode: bridge, host, none, service:<name> or container:<name>.')),
    restart: any(tr('When the container is restarted.'), { enum: RESTART }, { type: 'string', pattern: '^on-failure:\\d+$' }),
    healthcheck: cl(tr('How Docker checks that the container is healthy.'), {
      test: any(tr('The check command: a string, or ["CMD", …], ["CMD-SHELL", "…"] or ["NONE"].'), STRING, arr(null, STRING)),
      interval: duration(tr('Time between checks (for example 30s).')),
      timeout: duration(tr('How long a check may take.')),
      retries: int(tr('Failures in a row before the container is unhealthy.')),
      start_period: duration(tr('Time to start up during which failures do not count.')),
      start_interval: duration(tr('Time between checks during the start period.')),
      disable: { type: 'boolean' },
    }),
    labels: listOrMap(tr('Metadata labels of the container.')),
    deploy: cl(tr('Deployment and resource settings.'), {
      mode: en(null, ['global', 'replicated', 'replicated-job', 'global-job']),
      replicas: { type: ['integer', 'string'] },
      endpoint_mode: en(null, ['vip', 'dnsrr']),
      labels: listOrMap(),
      placement: obj(null, {}),
      resources: cl(tr('Resource limits and reservations.'), {
        limits: cl(null, { cpus: { type: ['number', 'string'] }, memory: STRING, pids: { type: 'integer' } }),
        reservations: cl(null, { cpus: { type: ['number', 'string'] }, memory: STRING, devices: arr(null, ANY), generic_resources: arr(null, ANY) }),
      }),
      restart_policy: cl(null, { condition: en(null, ['none', 'on-failure', 'any']), delay: STRING, max_attempts: { type: 'integer' }, window: STRING }),
      rollback_config: obj(null, {}),
      update_config: obj(null, {}),
    }),
    working_dir: str(tr('The working folder of the command in the container.')),
    user: str(tr('The user (and group) the command runs as.')),
    hostname: STRING,
    domainname: STRING,
    extra_hosts: listOrMap(tr('Extra host name mappings ("host:ip").')),
    logging: cl(tr('How the container logs.'), { driver: str(null, { examples: ['json-file', 'local', 'syslog', 'none'] }), options: map(null, ANY) }),
    profiles: strs(tr('Profiles that enable the service; without one it always starts.')),
    platform: str(tr('The platform of the image (for example linux/amd64).')),
    pull_policy: any(tr('When the image is pulled.'), { enum: ['always', 'never', 'missing', 'build', 'if_not_present', 'daily', 'weekly'] }, { type: 'string', pattern: '^every_' }),
    privileged: bool(tr('Gives the container extended privileges.'), false),
    read_only: bool(tr('Mounts the container file system read-only.'), false),
    stdin_open: bool(tr('Keeps standard input open (docker run -i).'), false),
    tty: bool(tr('Gives the container a terminal (docker run -t).'), false),
    init: bool(tr('Runs an init process that forwards signals and reaps processes.'), false),
    cap_add: strs(tr('Linux capabilities to add.')),
    cap_drop: strs(tr('Linux capabilities to drop.')),
    devices: arr(null, ANY),
    dns: strOrList(), dns_opt: strs(), dns_search: strOrList(),
    secrets: arr(tr('Secrets the service can read.'), any(null, STRING, obj(null, {}))),
    configs: arr(tr('Configs the service can read.'), any(null, STRING, obj(null, {}))),
    stop_grace_period: duration(tr('How long to wait after the stop signal before killing the container.')),
    stop_signal: str(tr('The signal that stops the container (SIGTERM when not set).')),
    shm_size: { type: ['string', 'number'] }, mem_limit: { type: ['string', 'number'] }, mem_reservation: { type: ['string', 'number'] },
    cpus: { type: ['number', 'string'] }, cpu_shares: { type: ['number', 'string'] }, cpuset: STRING,
    extends: any(tr('Takes the configuration of another service.'), STRING, cl(null, { service: STRING, file: STRING })),
    develop: cl(tr('Compose Watch: what to do when files change while developing.'), {
      watch: arr(null, cl(null, { path: STRING, action: en(null, ['rebuild', 'sync', 'sync+restart', 'restart', 'sync+exec']), target: STRING,
        ignore: strOrList(), include: strOrList(), initial_sync: { type: 'boolean' }, exec: obj(null, {}) })),
    }),
    scale: { type: ['integer', 'string'] },
    // Less common keys, accepted as they are.
    ...Object.fromEntries(['annotations', 'attach', 'blkio_config', 'cgroup', 'cgroup_parent', 'cpu_count', 'cpu_percent', 'cpu_period', 'cpu_quota',
      'cpu_rt_period', 'cpu_rt_runtime', 'credential_spec', 'device_cgroup_rules', 'driver_opts', 'external_links', 'gpus', 'group_add', 'ipc',
      'isolation', 'label_file', 'links', 'mac_address', 'mem_swappiness', 'memswap_limit', 'models', 'oom_kill_disable', 'oom_score_adj', 'pid',
      'pids_limit', 'post_start', 'pre_stop', 'provider', 'runtime', 'security_opt', 'storage_opt', 'sysctls', 'tmpfs', 'ulimits',
      'use_api_socket', 'userns_mode', 'uts'].map((k) => [k, ANY])),
  });
  const external = { type: ['boolean', 'object'] };
  const compose = cl(null, {
    version: str(tr('Obsolete: Compose ignores it.')),
    name: str(tr('The project name (the folder name when not set).')),
    include: arr(tr('Other Compose files to include.'), any(null, STRING, obj(null, {}))),
    services: map(tr('The services (containers) of the application.'), service),
    networks: map(tr('Networks the services can join.'), any(null, { type: 'null' }, cl(null, {
      driver: str(null, { examples: ['bridge', 'overlay', 'host', 'none'] }), driver_opts: map(null, ANY), attachable: { type: 'boolean' },
      enable_ipv4: { type: 'boolean' }, enable_ipv6: { type: 'boolean' }, external, internal: { type: 'boolean' }, ipam: obj(null, {}),
      labels: listOrMap(), name: STRING,
    }))),
    volumes: map(tr('Named volumes the services can mount.'), any(null, { type: 'null' }, cl(null, {
      driver: STRING, driver_opts: map(null, ANY), external, labels: listOrMap(), name: STRING,
    }))),
    configs: map(tr('Configuration files the services can read.'), any(null, { type: 'null' }, obj(null, {}))),
    secrets: map(tr('Secrets the services can read.'), any(null, { type: 'null' }, obj(null, {}))),
    models: map(null, ANY),
  });
  df.addYamlSchema((p) => /\/(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i.test(p), compose);
})();
