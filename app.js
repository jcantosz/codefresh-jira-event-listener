const https = require('https');

const flags = {
    // See debug messages?
    debug: process.env.DEBUG.toLowerCase() === 'true',
    trimInput: process.env.TRIM_INPUT.toLowerCase === "true",
    caseSensitive: process.env.CASE_SENSITIVE.toLowerCase() === 'true'
};

const config = {
    // The shared secret for the webhook. If present, this list will be searched with the request parameter
    webhookSecrets: (process.env.WEBHOOK_SECRETS) ? process.env.WEBHOOK_SECRETS.split(',') : null,

    // Codefresh communication details
    codefresh: {
        // Base URL (change if self-hosted)
        baseUrl: process.env.CODEFRESH_BASE_URL.trim(),
        // Port to access codefresh on (if self hosted and not on 443)
        port: parseInt(process.env.CODEFRESH_PORT),
        // Codefresh API key with pipeline approve access
        token: process.env.CODEFRESH_API_KEY.trim()
    },

    jira: {
        // The event type(s) to listen for on the webhook, generally this will just be one event type
        eventTypes: process.env.JIRA_EVENT_TYPES.split(',').map((str) => cleanInput(str)),
        // The names of the issue states that will cause the pipleine to be approved or denied
        states: {
            approve: process.env.JIRA_APPROVE_STATES.split(',').map((str) => cleanInput(str)),
            deny: process.env.JIRA_DENY_STATES.split(',').map((str) => cleanInput(str))
        },

         // The field to look for the pipeline id in
        customField: {
            name: cleanInput(process.env.JIRA_CUSTOM_FIELD),
            defaultId: cleanInput(process.env.JIRA_CUSTOM_FIELD)
        },
        // Parameters to use if auto-resolving the custom field ID from its name
        api: {
            // Flag to resolve custom field ID from its name
            resolveFields: process.env.JIRA_RESOLVE_FIELDS.toLowerCase() === 'true',
            // The base URL of Jira
            baseUrl: process.env.JIRA_BASE_URL.trim(),
            // The port Jira is hosted on (generally 443)
            port: parseInt(process.env.JIRA_PORT),
            // The username to communicate with Jira with
            username: process.env.JIRA_USERNAME.trim(),
            // The API token assocaited with the username
            token: process.env.JIRA_TOKEN.trim()
        }
    }
};

// Handle debug messages if switch is set
console.debug = (...args) => {
    if(flags.debug) {
        console.log.apply(this, args)
    }
}

/**
 * Clean input based on flags
 * @param input string to clean
 * @returns the cleaned input
**/
function cleanInput(input){
    let output = input;
    if (flags.trimInput) {
        output = output.trim()
    }
    if (!flags.caseSensitive) {
        output = output.toLowerCase()
    }
    return output;
}

/**
 * Call codefresh to approve or deny the pipeline
**/
function approveDenyPipeline(action, workflowId) {
    console.log("%sing pipeline %s", action, workflowId);
    //https://g.codefresh.io/api/workflow/${WORKFLOW_ID}/pending-approval/approve

    // Prepare a request to approve/deny a pipeline
    let req = {
        host: config.codefresh.baseUrl,
        port: config.codefresh.port,
        path: '/api/workflow/' + workflowId + '/pending-approval/' + action,

        // authentication headers
        headers: {
            'Authorization':  config.codefresh.token
        }
    };

    // Do a GET request as an async action that we will wait for
    const promise = new Promise(function(resolve, reject) {

        // Send the request to Codefresh
        https.get(req, (res) => {
            console.debug("res", res);
            resolve(res.statusCode);
          }).on('error', (e) => {
            console.error(e);
            reject(Error(e));
          });
    });
    return promise;
}

/**
 * Get the name of Jira's custom field that holds the codefresh pipeline id
**/
function getPipelineIdField(){
    // TODO: use Jira API user/key toget project metadata and custom field, ex:
    //curl -H "Authorization: Basic ${JIRA_API_AUTH}"  -X GET -H "Content-Type: application/json" \
    // 'https://<JIRA_DOMAIN>.atlassian.net/rest/api/latest/issue/createmeta?projectKeys=<PROJECT_KEY>&expand=projects.issuetypes.fields'

    const promise = new Promise(function(resolve, reject) {
        if (config.jira.api.resolveFields) {
            let encodedAuth = new Buffer(config.jira.api.username + ':' + config.jira.api.token).toString('base64');

            // TODO: parse the base url from the issue body
            if (!config.jira.api.baseUrl) {
            }

            // Prepare a request to get Jira custom field
            let req = {
                host: config.jira.api.baseUrl,
                port: config.jira.api.port,
                path: '/rest/api/3/field',

                // authentication headers
                headers: {
                    'Authorization':  'Basic ' + encodedAuth
                }
            };

            console.log("Resolving Jira custom field ID from name");
            // Request all fields from Jira
            https.get(req, (res) => {
                // Construct the returned body
                let body = '';
                res.on('data', function(chunk) {
                    body += chunk;
                });
                // When whole response is available
                res.on('end', function() {
                    // Turn the body string into JSON
                    const data = JSON.parse(body);
                    let keyFound = false;
                    // Search for our custom field in the field names
                    for (const field of data){
                        if (cleanInput(field.name) == config.jira.customField.name) {
                            keyFound = true;
                            console.log("Resolved custom field name %s to key %s", config.jira.customField.defaultId, field.key);
                            console.debug(field);
                            resolve(field.key);
                        }
                    }
                    // If we didn't find the key, resolve with the default key
                    if (!keyFound) {
                        console.log("Custom field name not resolved, trying the default (%s)", config.jira.customField.defaultId);
                        resolve(config.jira.customField.defaultId);
                    }
                });
            }).on('error', (e) => {
                console.error(e);
                reject(Error(e));
            });
        // If we are not using the API to resolve the field, return the one the user sent in
        } else {
            resolve(config.jira.customField.defaultId);
        }
    });

    // return the promise to get the Jira field
    return promise;
}

/**
 * Webhook handler - On a POST to this listener from Jira, check a the issue's state.
 * If the state has changed and it has moved into one of the states  listed in the 'states' varaible, approve or deny the pipeline it based on what list it is in
 * For all cases, return a 200
**/
exports.handler = async (event, context) => {
    //parse data
    const body = JSON.parse(event.body);
    const parameters = event.queryStringParameters;
    const method = event.httpMethod;

    console.log("New request");
    console.debug("Debug mode ON");
    console.debug("event httpMethod: ", method);
    console.debug("event queryStringParameters: ", parameters);
    console.debug("event body: ", JSON.stringify(body));

    // Response
    let response = {
        statusCode: 200,
        body: JSON.stringify('Webhook received!'),
    };

    // If we have webhook secrets set and this message does not have one that matches on in the list, reject this message
    if (config.webhookSecrets.length !== 0 && (!parameters.webhook_secret || !config.webhookSecrets.includes(parameters.webhook_secret)) ){
        response.statusCode = 500;
        response.body = JSON.stringify("access denied");

    // If we are getting a webhook with data and are authenticated
    } else if (method == 'POST') {
        // Store the query string parameters
        const issueId = parameters.issue_id;
        const issueKey = parameters.issue_key;
        const projectKey = parameters.project_key;
        const isseType = cleanInput(body.issue_event_type_name);

        console.debug("issueId: %s, issueKey: %s, projectKey: %s", issueId, issueKey, projectKey);
        console.debug("body: %s", body);
        console.debug("issueType", isseType);
        console.debug("changeLog", body.changelog);

        // If this is the event type we are interested in
        if (config.jira.eventTypes.includes(isseType)) {
            const changeItems = body.changelog.items;

            // Loop through the change list sent
            for (const item of changeItems){
                let action;
                const issueState = cleanInput(item.toString);
                const pipelineIdField = await getPipelineIdField();
                const workflowId = body.issue.fields[pipelineIdField];

                console.debug("Issue %s (%s) changed (change: %s) to %s", issueId, issueKey, item, issueState);
                console.debug("pipelineIdField: ", pipelineIdField);
                console.debug("workflowId: ", workflowId);

                if (config.jira.states.approve.includes(issueState)) {
                    action = 'approve';
                } else if (config.jira.states.deny.includes(issueState)) {
                    action = 'deny';
                }

                console.debug("action: ", action);

                if (action) {
                    // wait for the request to resolve
                    await approveDenyPipeline(action, workflowId);
                }
            }
        }
    }
    console.log("Processing request finished");
    // Respond to the webhook
    return response;
};
