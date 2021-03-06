'use babel';

const lazyReq = require('lazy-req')(require);
const { basename, delimiter, dirname } = lazyReq('path')(
  'basename', 'delimiter', 'dirname'
);
const { exec, parse, rangeFromLineNumber, tempFile } = lazyReq('atom-linter')(
  'exec', 'parse', 'rangeFromLineNumber', 'tempFile'
);
const os = lazyReq('os');
/**
 * Note that this can't be loaded lazily as `atom` doesn't export it correctly
 * for that, however as this comes from app.asar it is pre-compiled and is
 * essentially "free" as there is no expensive compilation step.
 */
import { CompositeDisposable } from 'atom';

// Some local variables
let subscriptions;
const errorWhitelist = [
  /^No config file found, using default configuration$/,
];
const lineRegex = '(?<line>\\d+),(?<col>\\d+),(?<type>\\w+),(\\w\\d+):(?<message>.*)\\r?(\\n|$)';

// Settings
let executable;
let rcFile;
let messageFormat;
let pythonPath;
let workingDirectory;

export function activate() {
  require('atom-package-deps').install('linter-pylint');

  subscriptions = new CompositeDisposable();

  // FIXME: This should be executablePath, saved for a major version bump
  subscriptions.add(atom.config.observe('linter-pylint.executable', value => {
    executable = value;
  }));
  subscriptions.add(atom.config.observe('linter-pylint.rcFile', value => {
    rcFile = value;
  }));
  subscriptions.add(atom.config.observe('linter-pylint.messageFormat', value => {
    messageFormat = value;
  }));
  subscriptions.add(atom.config.observe('linter-pylint.pythonPath', value => {
    pythonPath = value;
  }));
  subscriptions.add(atom.config.observe('linter-pylint.workingDirectory', value => {
    workingDirectory = value.replace(delimiter, '');
  }));
}

export function deactivate() {
  subscriptions.dispose();
}

function getProjectDir(filePath) {
  const atomProject = atom.project.relativizePath(filePath)[0];
  if (atomProject === null) {
    // Default project dirextory to file directory if path cannot be determined
    return dirname(filePath);
  }
  return atomProject;
}

function filterWhitelistedErrors(stderr) {
  // Split the input and remove blank lines
  const lines = stderr.split(os().EOL).filter(line => !!line);
  const filteredLines = lines.filter(line =>
    // Only keep the line if it is not ignored
    !errorWhitelist.some(errorRegex => errorRegex.test(line))
  );
  return filteredLines.join(os().EOL);
}

export function provideLinter() {
  return {
    name: 'Pylint',
    grammarScopes: ['source.python'],
    scope: 'file',
    lintOnFly: true,
    lint: (editor) => {
      const filePath = editor.getPath();
      const fileDir = dirname(filePath);
      const fileText = editor.getText();
      const projectDir = getProjectDir(filePath);
      const cwd = workingDirectory.replace(/%f/g, fileDir).replace(/%p/g, projectDir);
      const execPath = executable.replace(/%p/g, projectDir);
      let format = messageFormat;
      const patterns = {
        '%m': 'msg',
        '%i': 'msg_id',
        '%s': 'symbol',
      };
      Object.keys(patterns).forEach(pattern => {
        format = format.replace(new RegExp(pattern, 'g'), `{${patterns[pattern]}}`);
      });
      const env = Object.create(process.env, {
        PYTHONPATH: {
          value: [
            process.env.PYTHONPATH, fileDir, projectDir,
            pythonPath.replace(/%f/g, fileDir).replace(/%p/g, projectDir),
          ].filter(x => !!x).join(delimiter),
          enumerable: true,
        },
        LANG: { value: 'en_US.UTF-8', enumerable: true },
      });

      const args = [
        `--msg-template='{line},{column},{category},{msg_id}:${format}'`,
        '--reports=n',
        '--output-format=text',
      ];
      if (rcFile) {
        args.push(`--rcfile=${rcFile.replace(/%p/g, projectDir).replace(/%f/g, fileDir)}`);
      }
      return tempFile(basename(filePath), fileText, (tmpFileName) => {
        args.push(tmpFileName);
        return exec(execPath, args, { env, cwd, stream: 'both' }).then(data => {
          const filteredErrors = filterWhitelistedErrors(data.stderr);
          if (filteredErrors) {
            throw new Error(filteredErrors);
          }
          return parse(data.stdout, lineRegex, { filePath })
            .filter(issue => issue.type !== 'info')
            .filter(issue => {
              const [[lineStart, colStart], [lineEnd, colEnd]] = issue.range;
              // Sometimes we get bad results, so we don't show this issue (for now)
              if (lineStart === undefined) return false;
              // Sometimes the editor has changed since we started linting, so we ignore lines we
              // can't annotate anymore (we'll get them when we finish processing the latest editor
              // change event)
              try {
                lineLength = editor.getBuffer().lineLengthForRow(lineStart);
                return colStart <= lineLength;
              } catch (exception) {
                // The line has been deleted?
                return false;
              }
            })
            .map(issue => {
              const [[lineStart, colStart], [lineEnd, colEnd]] = issue.range;
              if (lineStart === lineEnd && (colStart <= colEnd || colEnd <= 0)) {
                Object.assign(issue, {
                  range: rangeFromLineNumber(editor, lineStart, colStart),
                });
              }
              return issue;
            });
        });
      });
    },
  };
}
