const yaml = require('js-yaml')
const fs = require('fs')
const promisify = require('util').promisify
const readFile = promisify(fs.readFile.bind(fs))

async function generateAddon(yamlPath, addonPath) {
	const doc = yaml.safeLoad(await readFile(yamlPath, 'utf8'));
	console.log(doc.catalog.items)
}
 
generateAddon('./kyuchek.yaml', './dist')
