const { withAppDelegate } = require('@expo/config-plugins');

const CALL = '    excludeSensitiveDataFromBackup()';
const METHOD = `

  private func excludeSensitiveDataFromBackup() {
    let fileManager = FileManager.default
    let directories: [FileManager.SearchPathDirectory] = [.documentDirectory, .applicationSupportDirectory]
    for directory in directories {
      guard var directoryUrl = fileManager.urls(for: directory, in: .userDomainMask).first else { continue }
      try? fileManager.createDirectory(at: directoryUrl, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? directoryUrl.setResourceValues(values)
    }
  }
`;

function addBackupExclusionToSwift(source) {
  if (source.includes('excludeSensitiveDataFromBackup()')) return source;
  const returnPattern = /(\n)(\s*)(return (?:result|super\.application\())/;
  const match = source.match(returnPattern);
  if (!match) throw new Error('AppDelegate Swift non riconosciuto: impossibile applicare la protezione backup.');
  const withCall = source.replace(returnPattern, `$1${CALL}\n$2$3`);
  const closingBrace = withCall.lastIndexOf('\n}');
  if (closingBrace < 0) throw new Error('AppDelegate Swift privo della chiusura attesa.');
  return `${withCall.slice(0, closingBrace)}${METHOD}${withCall.slice(closingBrace)}`;
}

module.exports = function withSensitiveDataBackupExclusion(config) {
  return withAppDelegate(config, (next) => {
    if (next.modResults.language !== 'swift') {
      throw new Error('La protezione backup iOS richiede AppDelegate Swift.');
    }
    next.modResults.contents = addBackupExclusionToSwift(next.modResults.contents);
    return next;
  });
};

module.exports.addBackupExclusionToSwift = addBackupExclusionToSwift;
