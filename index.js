var mssql = require('mssql');
var Port = require('ut-bus/port');
var util = require('util');
var fs = require('fs');
var when = require('when');
var errors = require('./errors');
var uterror = require('ut-error');
var mssqlQueries = require('./sql');
const AUDIT_LOG = /^[\s+]{0,}--ut-audit-params$/m;

function SqlPort() {
    Port.call(this);
    this.config = {
        id: null,
        logLevel: '',
        type: 'sql',
        createTT: false,
        tableToType: {}
    };
    this.super = {};
    this.connection = null;
    this.retryTimeout = null;
    return this;
}

function fieldSource(column) {
    return (column.column + '\t' + column.type + '\t' + (column.length || '') + '\t' + (column.scale || '')).toLowerCase();
}

util.inherits(SqlPort, Port);

SqlPort.prototype.init = function init() {
    Port.prototype.init.apply(this, arguments);
    this.latency = this.counter && this.counter('average', 'lt', 'Latency');
};

SqlPort.prototype.connect = function connect() {
    this.connection && this.connection.close();
    this.connectionReady = false;
    var self = this;

    return this.tryConnect()
        .then(this.refreshView.bind(this, true))
        .then(this.loadSchema.bind(this, null))
        .then(this.updateSchema.bind(this))
        .then(this.refreshView.bind(this, false))
        .then(this.linkSP.bind(this))
        .then(function(v) { self.connectionReady = true; return v; })
        .catch(function(err) {
            try { this.connection.close(); } catch (e) {};
            this.retryTimeout = setTimeout(this.connect.bind(this), 10000);
            this.log.error && this.log.error(err);
        }.bind(this));
};

SqlPort.prototype.start = function start() {
    this.bus && this.bus.importMethods(this.config, this.config.imports, undefined, this);
    if (Array.isArray(this.config.createTT)) {
        this.config.tableToType = this.config.createTT.reduce(function(obj, tableName) {
            obj[tableName.toLowerCase()] = true;
            return obj;
        }, {});
    }
    return Port.prototype.start.apply(this, Array.prototype.slice.call(arguments))
        .then(this.connect.bind(this))
        .then(function(result) {
            this.pipeExec(this.exec.bind(this), this.config.concurrency);
            return result;
        }.bind(this));
};

SqlPort.prototype.stop = function stop() {
    clearTimeout(this.retryTimeout);
    // this.queue.push();
    this.connectionReady = false;
    this.connection.close();
    Port.prototype.stop.apply(this, Array.prototype.slice.call(arguments));
};

function setPathProperty(object, fieldName, fieldValue) {
    var path = fieldName.split('.');
    fieldName = path.pop();
    path.forEach(function(name) {
        if (name) {
            if (!(object[name] instanceof Object)) {
                object[name] = {};
            }
            object = object[name];
        }
    });
    object[fieldName] = fieldValue;
}

SqlPort.prototype.checkConnection = function(checkReady) {
    if (!this.connection) {
        throw errors.noConnection({
            server: this.config.db && this.config.db.server,
            database: this.config.db && this.config.db.database
        });
    }
    if (checkReady && !this.connectionReady) {
        throw errors.notReady({
            server: this.config.db && this.config.db.server,
            database: this.config.db && this.config.db.database
        });
    }
};

/**
 * @function exec
 * @description Handles SQL query execution
 * @param {Object} message
 */
SqlPort.prototype.exec = function(message) {
    var $meta = (arguments.length && arguments[arguments.length - 1]);
    var methodName = ($meta && $meta.method);
    if (methodName) {
        var method = this.config[methodName];
        if (method instanceof Function) {
            return when.lift(method).apply(this, Array.prototype.slice.call(arguments));
        }
    }

    this.checkConnection(true);

    if (this.config.validate instanceof Function) {
        this.config.validate(message);
    }

    // var start = +new Date();
    var debug = this.isDebug();
    var request = this.getRequest();
    return when.promise(function(resolve, reject) {
        request.query(message.query, function(err, result) {
            // var end = +new Date();
            // var execTime = end - start;
            // todo record execution time
            if (err) {
                debug && (err.query = message.query);
                var error = uterror.get(err.message) || errors.sql;
                reject(error(err));
            } else {
                $meta.mtid = 'response';
                if (message.process === 'return') {
                    if (result && result.length) {
                        Object.keys(result[0]).forEach(function(value) {
                            setPathProperty(message, value, result[0][value]);
                        });
                    }
                    resolve(message);
                } else if (message.process === 'json') {
                    message.dataSet = result;
                    resolve(message);
                } else if (message.process === 'xls') { // todo
                    reject(errors.notImplemented(message.process));
                } else if (message.process === 'xml') { // todo
                    reject(errors.notImplemented(message.process));
                } else if (message.process === 'csv') { // todo
                    reject(errors.notImplemented(message.process));
                } else if (message.process === 'processRows') { // todo
                    reject(errors.notImplemented(message.process));
                } else if (message.process === 'queueRows') { // todo
                    reject(errors.notImplemented(message.process));
                } else {
                    reject(errors.missingProcess(message.process));
                }
            }
        });
    });
};

SqlPort.prototype.getSchema = function() {
    var result = [];
    if (this.config.schema) {
        if (Array.isArray(this.config.schema)) {
            result = this.config.schema.slice();
        } else {
            result.push({path: this.config.schema});
        }
    }
    this.config.imports && this.config.imports.forEach(function(imp) {
        imp.match(/\.schema$/) && Array.prototype.push.apply(result, this.config[imp]);
        this.config[imp + '.schema'] && Array.prototype.push.apply(result, this.config[imp + '.schema']);
    }.bind(this));
    return result;
};

SqlPort.prototype.updateSchema = function(schema) {
    this.checkConnection();

    function getAlterStatement(statement) {
        if (statement.match(AUDIT_LOG)) {
            statement = replaceAuditLog(statement);
        }
        if (statement.trim().match(/^CREATE\s+TYPE/i)) {
            return statement.trim();
        } else {
            return statement.trim().replace(/^CREATE /i, 'ALTER ');
        }
    }

    function replaceAuditLog(statement) {
        var parserSP = require('./parsers/mssqlSP');
        var binding = parserSP.parse(statement);
        return statement.trim().replace(AUDIT_LOG, mssqlQueries.auditLog(binding));
    }

    function tableToType(statement) {
        var result = '';
        if (statement.match(/^CREATE\s+TABLE/i)) {
            var parserSP = require('./parsers/mssqlSP');
            var binding = parserSP.parse(statement);
            if (binding.type === 'table') {
                var name = binding.name.match(/\]$/) ? binding.name.slice(0, -1) + 'TT]' : binding.name + 'TT';
                var columns = binding.fields.map(function(field) {
                    return ('[' + field.column + '] [' + field.type + ']' + (field.length ? '(' + field.length + ')' : ''));
                });
                result = 'CREATE TYPE ' + name + ' AS TABLE (\r\n  ' + columns.join(',\r\n  ') + '\r\n)';
            }
        }
        return result;
    }

    function getCreateStatement(statement) {
        if (statement.match(AUDIT_LOG)) {
            statement = replaceAuditLog(statement);
        }
        return statement.trim().replace(/^ALTER /i, 'CREATE ');
    }

    function getSource(statement) {
        if (statement.match(AUDIT_LOG)) {
            statement = replaceAuditLog(statement);
        }
        if (statement.trim().match(/^CREATE\s+TYPE/i)) {
            var parserSP = require('./parsers/mssqlSP');
            var binding = parserSP.parse(statement);
            if (binding && binding.type === 'table type') {
                return binding.fields.map(fieldSource).join('\r\n');
            }
        }
        return statement.trim().replace(/^ALTER /i, 'CREATE ');
    }

    function addQuery(queries, params) {
        if (schema.source[params.objectId] === undefined) {
            queries.push({fileName: params.fileName, objectName: params.objectName, objectId: params.objectId, content: params.createStatement});
        } else {
            if (schema.source[params.objectId].length && (getSource(params.fileContent) !== schema.source[params.objectId])) {
                var deps = schema.deps[params.objectId];
                if (deps) {
                    deps.names.forEach(function(dep) {
                        delete schema.source[dep];
                    });
                    queries.push({
                        fileName: params.fileName,
                        objectName: params.objectName + ' drop dependencies',
                        objectId: params.objectId,
                        content: deps.drop.join('\r\n')
                    });
                }
                queries.push({
                    fileName: params.fileName,
                    objectName: params.objectName,
                    objectId: params.objectId,
                    content: getAlterStatement(params.fileContent)
                });
            }
        }
    }

    function getObjectName(fileName) {
        return fileName.replace(/\.sql$/i, '').replace(/^[^\$]*\$/, ''); // remove "prefix$" and ".sql" suffix
    }

    function shouldCreateTT(tableName) {
        if (self.config.createTT === true || self.config.tableToType[tableName] === true) {
            return true;
        }
        return false;
    }

    var self = this;
    var schemas = this.getSchema();
    if (!schemas) {
        return schema;
    }

    return when.reduce(schemas, function(prev, schemaConfig) { // visit each schema folder
        return when.promise(function(resolve, reject) {
            fs.readdir(schemaConfig.path, function(err, files) {
                if (err) {
                    reject(err);
                } else {
                    var queries = [];
                    files = files.sort();
                    var objectIds = files.reduce(function(prev, cur) {
                        prev[getObjectName(cur).toLowerCase()] = true;
                        return prev;
                    }, {});
                    files.forEach(function(file) {
                        var objectName = getObjectName(file);
                        var objectId = objectName.toLowerCase();
                        schemaConfig.linkSP && prev.push(objectId);
                        var fileName = schemaConfig.path + '/' + file;
                        var fileContent = fs.readFileSync(fileName).toString();
                        addQuery(queries, {
                            fileName: fileName,
                            objectName: objectName,
                            objectId: objectId,
                            fileContent: fileContent,
                            createStatement: getCreateStatement(fileContent)
                        });
                        if (shouldCreateTT(objectId) && !objectIds[objectId + 'tt']) {
                            var tt = tableToType(fileContent.trim().replace(/^ALTER /i, 'CREATE '));
                            if (tt) {
                                addQuery(queries, {
                                    fileName: fileName,
                                    objectName: objectName + 'TableType',
                                    objectId: objectId + 'tt',
                                    fileContent: tt,
                                    createStatement: tt
                                });
                            }
                        }
                    });

                    var request = self.getRequest();
                    var currentFileName = '';
                    var updated = [];
                    when.reduce(queries, function(result, query) {
                        updated.push(query.objectName);
                        currentFileName = query.fileName;
                        return request.batch(query.content);
                    }, [])
                    .then(function() {
                        updated.length && self.log.info && self.log.info({message: updated, $meta: {opcode: 'updateSchema'}});
                        resolve(prev);
                    })
                    .catch(function(error) {
                        error.fileName = currentFileName;
                        error.message = error.message + ' (' + currentFileName + ':' + (error.lineNumber || 1) + ':1)';
                        reject(error);
                    });
                }
            });
        }, []);
    }, [])
    .then(function(objectList) {
        return self.loadSchema(objectList);
    });
};

SqlPort.prototype.execTemplate = function(template, params) {
    var self = this;
    return template.render(params).then(function(query) {
        return self.exec({query: query, process: 'json'})
            .then(function(result) {
                return result && result.dataSet;
            });
    });
};

SqlPort.prototype.execTemplateRow = function(template, params) {
    return this.execTemplate(template, params).then(function(data) {
        var result = (data && data[0]) || {};
        if (result._errorCode && parseInt(result._errorCode, 10) !== 0) {
            // throw error if _errorCode is '', undefined, null, number (different than 0) or string (different than '0', '00', etc.)
            throw errors.sql({
                code: result._errorCode || -1,
                message: result._errorMessage || 'sql error'
            });
        } else {
            return result;
        }
    });
};

SqlPort.prototype.execTemplateRows = function(template, params) {
    return this.execTemplate(template, params).then(function(data) {
        var result = data || [{}];
        if (result[0] && result[0]._errorCode && parseInt(result[0]._errorCode, 10) !== 0) {
            // throw error if _errorCode is '', undefined, null, number (different than 0) or string (different than '0', '00', etc.)
            throw errors.sql({
                code: result[0]._errorCode || -1,
                message: result[0]._errorMessage || 'sql error'
            });
        } else {
            return result;
        }
    });
};

SqlPort.prototype.getRequest = function() {
    return new mssql.Request(this.connection);
};

SqlPort.prototype.callSP = function(name, params, flatten) {
    var self = this;
    var outParams = [];

    params && params.forEach(function(param) {
        param.out && outParams.push(param.name);
    });

    function sqlType(def) {
        var type;
        if (def.type === 'table') {
            type = def.create();
        } else {
            type = mssql[def.type.toUpperCase()];
        }
        if (def.size) {
            if (Array.isArray(def.size)) {
                type = type(def.size[0], def.size[1]);
            } else {
                type = (def.size === 'max') ? type(mssql.MAX) : type(def.size);
            }
        }
        return type;
    }

    function flattenMessage(data) {
        var result = {};
        function recurse(cur, prop) {
            if (Object(cur) !== cur) {
                result[prop] = cur;
            } else if (Array.isArray(cur)) {
                // for (var i = 0, l = cur.length; i < l; i += 1) {
                //     recurse(cur[i], prop + '[' + i + ']');
                // }
                // if (l === 0) {
                //     result[prop] = [];
                // }
                result[prop] = cur;
            } else {
                var isEmpty = true;
                for (var p in cur) {
                    isEmpty = false;
                    recurse(cur[p], prop ? prop + '_' + p : p);
                }
                if (isEmpty && prop) {
                    result[prop] = {};
                }
            }
        }
        recurse(data, '');
        return result;
    }
    function getValue(column, value) {
        if (value) {
            if (column.type.declaration.startsWith('date')) {
                // set a javascript date for 'date', 'datetime' and 'datetime2'
                value = new Date(value);
            }
        }
        return value;
    }
    return function callLinkedSP(msg) {
        self.checkConnection(true);
        var request = self.getRequest();
        var data = flatten ? flattenMessage(msg) : msg;
        var debug = this.isDebug();
        var debugParams = {};
        request.multiple = true;
        params && params.forEach(function(param) {
            var value = param.update ? (data[param.name] || data.hasOwnProperty(param.update)) : data[param.name];
            var type = sqlType(param.def);
            debug && (debugParams[param.name] = value);
            if (param.out) {
                request.output(param.name, type, value);
            } else {
                if (param.def && param.def.type === 'table') {
                    if (value) {
                        if (Array.isArray(value)) {
                            value.forEach(function(row) {
                                if (typeof row === 'object') {
                                    type.rows.add.apply(type.rows, param.columns.reduce(function(prev, cur, i) {
                                        prev.push(getValue(type.columns[i], row[cur]));
                                        return prev;
                                    }, []));
                                } else {
                                    type.rows.add.apply(type.rows, [getValue(type.columns[0], row)].concat(new Array(param.columns.length - 1)));
                                }
                            });
                        } else if (typeof value === 'object') {
                            type.rows.add.apply(type.rows, param.columns.reduce(function(prev, cur, i) {
                                prev.push(getValue(type.columns[i], value[cur]));
                                return prev;
                            }, []));
                        } else {
                            type.rows.add.apply(type.rows, [getValue(type.columns[0], value)].concat(new Array(param.columns.length - 1)));
                        }
                    }
                    request.input(param.name, type);
                } else {
                    request.input(param.name, type, value);
                }
            }
        });
        return request.execute(name)
            .then(function(result) {
                if (outParams.length) {
                    result.push([outParams.reduce(function(prev, curr) {
                        prev[curr] = request.parameters[curr].value;
                        return prev;
                    }, {})]);
                }
                return result;
            })
            .catch(function(err) {
                debug && (err.storedProcedure = name);
                debug && (err.params = debugParams);
                var error = uterror.get(err.message) || errors.sql;
                throw error(err);
            });
    };
};

SqlPort.prototype.linkSP = function(schema) {
    if (schema.parseList.length) {
        var parserSP = require('./parsers/mssqlSP');
        schema.parseList.forEach(function(source) {
            var binding = parserSP.parse(source);
            var flatName = binding.name.replace(/[\[\]]/g, '');
            if (binding && binding.type === 'procedure') {
                var update = [];
                var flatten = false;
                binding.params && binding.params.forEach(function(param) {
                    update.push(param.name + '$update');
                    // flatten in case a parameter's name have at least one underscore character surrounded by non underscore characters
                    if (!flatten && param.name.match(/[^_]_[^_]/)) {
                        flatten = true;
                    }
                });
                binding.params && binding.params.forEach(function(param) {
                    (update.indexOf(param.name) >= 0) && (param.update = param.name.replace(/\$update$/i, ''));
                    if (param.def && param.def.type === 'table') {
                        var columns = schema.types[param.def.typeName.toLowerCase()];
                        param.columns = [];
                        columns.forEach(function(column) {
                            param.columns.push(column.column);
                        });
                        param.def.create = function() {
                            var table = new mssql.Table(param.def.typeName.toLowerCase());
                            columns && columns.forEach(function(column) {
                                var type = mssql[column.type.toUpperCase()];
                                if (!(type instanceof Function)) {
                                    throw errors.unexpectedType({
                                        type: column.type,
                                        procedure: binding.name
                                    });
                                }
                                if (typeof column.length === 'string' && column.length.match(/^max$/i)) {
                                    table.columns.add(column.column, type(mssql.MAX));
                                } else {
                                    table.columns.add(column.column, type(column.length, column.scale));
                                }
                            });
                            return table;
                        };
                    }
                });
                this.super[flatName] = this.callSP(binding.name, binding.params, flatten).bind(this);
                if (!this.config[flatName]) {
                    this.config[flatName] = this.super[flatName];
                }
            }
        }.bind(this));
    }
    return schema;
};

SqlPort.prototype.loadSchema = function(objectList) {
    var self = this;
    var schema = this.getSchema();
    if ((Array.isArray(schema) && !schema.length) || !schema) {
        return {source: {}, parseList: []};
    }

    this.checkConnection();
    var request = this.getRequest();
    request.multiple = true;

    return request.query(mssqlQueries.loadSchema()).then(function(result) {
        var schema = {source: {}, parseList: [], types: {}, deps: {}};
        result[0].reduce(function(prev, cur) { // extract source code of procedures, views, functions, triggers
            cur.namespace = cur.namespace && cur.namespace.toLowerCase();
            cur.full = cur.full && cur.full.toLowerCase();
            if (cur.source) {
                prev.source[cur.full] = (prev.source[cur.full] || '') + (cur.source || '');
            } else if (cur.full) {
                prev.source[cur.full] = '';
            } else {
                prev.source[cur.namespace] = '';
            }
            if ((cur.type === 'P') && (cur.colid === 1) && (self.config.linkSP || (objectList && objectList.indexOf(cur.full) >= 0))) {
                prev.parseList.push(cur.source);
            }
            return prev;
        }, schema);
        result[1].reduce(function(prev, cur) { // extract columns of user defined table types
            if (!(mssql[cur.type.toUpperCase()] instanceof Function)) {
                throw errors.unexpectedColumnType({
                    type: cur.type,
                    userDefinedTableType: cur.name
                });
            }
            cur.name = cur.name && cur.name.toLowerCase();
            var type = prev[cur.name] || (prev[cur.name] = []);
            type.push(cur);
            return prev;
        }, schema.types);
        result[2].reduce(function(prev, cur) { // extract dependencies
            cur.name = cur.name && cur.name.toLowerCase();
            cur.type = cur.type && cur.type.toLowerCase();
            var dep = prev[cur.type] || (prev[cur.type] = {names: [], drop: []});
            if (dep.names.indexOf(cur.name) < 0) {
                dep.names.push(cur.name);
                dep.drop.push(cur.drop);
            }
            return prev;
        }, schema.deps);
        Object.keys(schema.types).forEach(function(type) { // extract pseudo source code of user defined table types
            schema.source[type] = schema.types[type].map(fieldSource).join('\r\n');
        });
        return schema;
    });
};

SqlPort.prototype.refreshView = function(drop, data) {
    this.checkConnection();
    var request = this.getRequest();
    return request.query(mssqlQueries.refreshView(drop)).then(function(result) {
        if (!drop && result && result.length) {
            throw errors.invalidView(result);
        } else {
            return data;
        }
    });
};

SqlPort.prototype.doc = function() {
    this.checkConnection();
    var self = this;
    var schemas = this.getSchema();
    var parserSP = require('./parsers/mssqlSP');
    return when.reduce(schemas, function(prev, schemaConfig) { // visit each schema folder
        return when.promise(function(resolve, reject) {
            fs.readdir(schemaConfig.path, function(err, files) {
                if (err) {
                    reject(err);
                } else {
                    files = files.sort();
                    files.forEach(function(file) {
                        var fileName = schemaConfig.path + '/' + file;
                        var fileContent = fs.readFileSync(fileName).toString();
                        if (fileContent.trim().match(/^(\bCREATE\b|\bALTER\b)\s+PROCEDURE/i) || fileContent.trim().match(/^(\bCREATE\b|\bALTER\b)\s+TABLE/i)) {
                            var binding = parserSP.parse(fileContent);
                            var fields = binding.type === 'procedure' ? binding.params : binding.fields;
                            fields.map((field) => {
                                if (field.doc) {
                                    var doc = {
                                        type0: 'schema', name0: binding.schema,
                                        type1: 'table', name1: binding.table,
                                        type2: 'column', name2: field.name || field.column,
                                        doc: field.doc
                                    };
                                    prev.push(doc);
                                }
                            });
                        }
                    });
                    resolve(prev);
                }
            });
        }, []);
    }, [])
    .then(function(docList) {
        var request = self.getRequest();
        request.multiple = true;
        var docListParam = new mssql.Table('core.documentationTT');
        docListParam.columns.add('type0', mssql.VarChar(128));
        docListParam.columns.add('name0', mssql.NVarChar(128));
        docListParam.columns.add('type1', mssql.VarChar(128));
        docListParam.columns.add('name1', mssql.NVarChar(128));
        docListParam.columns.add('type2', mssql.VarChar(128));
        docListParam.columns.add('name2', mssql.NVarChar(128));
        docListParam.columns.add('doc', mssql.NVarChar(2000));
        docList.forEach(function(doc) {
            docListParam.rows.add(doc.type0, doc.name0, doc.type1, doc.name1, doc.type2, doc.name2, doc.doc);
        });
        request.input('docList', docListParam);
        return request.execute('core.documentation');
    });
};

SqlPort.prototype.tryConnect = function() {
    this.connection = new mssql.Connection(this.config.db);
    if (this.config.create) {
        var conCreate = new mssql.Connection({
            server: this.config.db.server,
            user: this.config.create.user,
            password: this.config.create.password
        });
        return conCreate.connect()
        .then(() => (new mssql.Request(conCreate)).batch(mssqlQueries.createDatabase(this.config.db.database)))
        .then(() => (new mssql.Request(conCreate)).batch(mssqlQueries.createUser(this.config.db.database, this.config.db.user, this.config.db.password)))
        .then(() => conCreate.close())
        .then(() => this.connection.connect())
        .catch((err) => {
            try { this.conCreate.close(); } catch (e) {};
            throw err;
        });
    } else {
        return this.connection.connect();
    }
};

module.exports = SqlPort;
