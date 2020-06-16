const yaml = require('js-yaml')
const fs = require('fs')
const promisify = require('util').promisify
const readFile = promisify(fs.readFile.bind(fs))
const writeFile = promisify(fs.writeFile.bind(fs))
const mkdirp = require('mkdirp')
const path = require('path')
const assert = require('assert')

async function generateAddon(yamlPath, addonPath) {
	const doc = yaml.safeLoad(await readFile(yamlPath, 'utf8'))
	assert.ok(doc.addon, 'has addon field')
	assert.ok(doc.catalog, 'has catalog')
	const cat = doc.catalog
	console.log(doc.addon)
	console.log(doc.catalog)
	await writeToFile(path.join(addonPath, 'manifest.json'), {
		id: `com.autogen.${cat.type}`,
		name: doc.addon.name,
		version: doc.addon.version,
		description: doc.addon.description || '',
		resources: ['meta'],
		types: [cat.type],
		catalogs: [{ type: cat.type, id: 'main', name: doc.addon.name }]
	})
}

async function writeToFile(fpath, content) {
	await mkdirp(path.dirname(fpath))
	await writeFile(fpath, JSON.stringify(content))
}
 
generateAddon('./kyuchek.yaml', './dist')
