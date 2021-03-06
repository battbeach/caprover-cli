#!/usr/bin/env node

import * as inquirer from 'inquirer'
import Constants from '../utils/Constants'
import StdOutUtil from '../utils/StdOutUtil'
import { isIpAddress } from '../utils/ValidationsHandler'
import { IMachine } from '../models/storage/StoredObjects'
import CliApiManager from '../api/CliApiManager'
import Utils from '../utils/Utils'
import CliHelper from '../utils/CliHelper'
import StorageHelper from '../utils/StorageHelper'
import ErrorFactory from '../utils/ErrorFactory'
import SpinnerHelper from '../utils/SpinnerHelper'
import { fstat, existsSync, readFileSync } from 'fs'
import { readJsonSync, pathExistsSync } from 'fs-extra'
import { join } from 'path'
import * as yaml from 'js-yaml'
import { IServerSetupParams } from '../models/IConfigParams';

let newPasswordFirstTry: string | undefined = undefined
let lastWorkingPassword: string = Constants.DEFAULT_PASSWORD
let serverIpAddress = ''

let captainMachine: IMachine = {
    authToken: '',
    baseUrl: '',
    name: '',
}

async function getAuthTokenFromIp(ipFromUser: string) {
    try {
        // login using captain42. and set the ipAddressToServer
        captainMachine.baseUrl = `http://${ipFromUser}:3000`
        let authToken = await CliApiManager.get(captainMachine).getAuthToken(
            lastWorkingPassword
        )
        serverIpAddress = ipFromUser

        return authToken
    } catch (e) {
        // User may have used a different default password
        if (e.captainStatus === ErrorFactory.STATUS_WRONG_PASSWORD) return ''

        if ((e + '').indexOf('Found. Redirecting to https://') >= 0) {
            StdOutUtil.printError(
                '\n\n**** You may have already setup the server! Use caprover login to log into an existing server.'
            )
        }

        StdOutUtil.errorHandler(e)
    }
}

async function tryNewPassword(password: string) {
    try {
        await CliApiManager.get(captainMachine).getAuthToken(password)
        lastWorkingPassword = password
        return ''
    } catch (e) {
        StdOutUtil.errorHandler(e)
    }
}

async function updateRootDomain(captainRootDomainFromUser: string) {
    try {
        await CliApiManager.get(captainMachine).updateRootDomain(
            captainRootDomainFromUser
        )
        captainMachine = Utils.copyObject(captainMachine)
        captainMachine.baseUrl = `http://captain.${captainRootDomainFromUser}`
    } catch (e) {
        StdOutUtil.printError('\n\n')
        if (e.captainStatus === ErrorFactory.VERIFICATION_FAILED) {
            if (captainRootDomainFromUser.indexOf('/') >= 0) {
                StdOutUtil.printError(
                    'DO NOT include http in your base domain, it should be just plain domain, e.g., test.domain.com'
                )
            }

            if (captainRootDomainFromUser.indexOf('*') >= 0) {
                StdOutUtil.printError(
                    'DO NOT include * in your base domain, it should be just plain domain, e.g., test.domain.com'
                )
            }

            StdOutUtil.printError(
                `\n\nCannot verify that http://captain.${captainRootDomainFromUser} points to your server IP.\n` +
                    `\nAre you sure that you set *.${captainRootDomainFromUser} points to ${serverIpAddress}\n\n` +
                    `Double check your DNS. If everything looks correct, note that, DNS changes take up to 24 hrs to work properly. Check with your Domain Provider.`
            )
        }
        StdOutUtil.errorHandler(e)
    }
}

async function enableSslAndChangePassword(emailAddressFromUser: string) {
    let forcedSsl = false
    try {
        SpinnerHelper.start('Enabling SSL... Takes a few seconds...')
        await CliApiManager.get(captainMachine).enableRootSsl(
            emailAddressFromUser
        )

        captainMachine = Utils.copyObject(captainMachine)
        captainMachine.baseUrl = captainMachine.baseUrl.replace(
            'http://',
            'https://'
        )

        await CliApiManager.get(captainMachine).forceSsl(true)
        forcedSsl = true
        await CliApiManager.get(captainMachine).changePass(
            lastWorkingPassword,
            newPasswordFirstTry!
        )
        lastWorkingPassword = newPasswordFirstTry!
        await CliApiManager.get(captainMachine).getAuthToken(
            lastWorkingPassword
        )
        SpinnerHelper.stop()
    } catch (e) {
        if (forcedSsl) {
            StdOutUtil.printError(
                'Server is setup, but password was not changed due to an error. You cannot use serversetup again.'
            )
            StdOutUtil.printError(
                `Instead, go to ${
                    captainMachine.baseUrl
                } and change your password on settings page.`
            )
            StdOutUtil.printError(
                `Then, Use caprover login on your local machine to connect to your server.`
            )
        }
        SpinnerHelper.fail()
        StdOutUtil.errorHandler(e)
    }
}

function getErrorForMachineName(newMachineName: string) {
    let errorMessage = undefined
    if (StorageHelper.get().findMachine(newMachineName)) {
        return `${newMachineName} already exist. If you want to replace the existing entry, you have to first use <logout> command, and then re-login.`
    }

    if (CliHelper.get().isNameValid(newMachineName)) {
        captainMachine.name = newMachineName
        return true
    }

    return 'Please enter a valid CapRover Name. Small letters, numbers, single hyphen.'
}

const questions = [
    {
        type: 'list',
        name: 'hasInstalledCaptain',
        message:
            'Have you already installed CapRover on your server by running the following line:' +
            '\nmkdir /captain && docker run -p 80:80 -p 443:443 -p 3000:3000 -v /var/run/docker.sock:/var/run/docker.sock caprover/caprover ?',
        default: 'Yes',
        choices: ['Yes', 'No'],
        filter: (value: string) => {
            const answerFromUser = value.trim()

            if (answerFromUser === 'Yes') return answerFromUser

            StdOutUtil.printMessage(
                '\n\nCannot start the setup process if CapRover is not installed.'
            )

            StdOutUtil.printMessageAndExit(
                'Please read tutorial on CapRover.com to learn how to install CapRover on a server.'
            )
        },
    },
    {
        type: 'input',
        default: Constants.SAMPLE_IP,
        name: 'captainAddress',
        message: 'Enter IP address of your CapRover server:',
        filter: async (value: string) => {
            const ipFromUser = value.trim()

            if (
                ipFromUser === Constants.SAMPLE_IP ||
                !isIpAddress(ipFromUser)
            ) {
                StdOutUtil.printError(
                    `\nThis is an invalid IP Address: ${ipFromUser}`,
                    true
                )
            }

            captainMachine.authToken =
                (await getAuthTokenFromIp(ipFromUser)) || ''
            return ipFromUser
        },
    },
    {
        type: 'password',
        name: 'captainOriginalPassword',
        message: 'Enter your current password:',
        when: () => !captainMachine.authToken, // The default password didn't work
        filter: async (value: string) => {
            await tryNewPassword(value)
        },
    },
    {
        type: 'input',
        name: 'rootDomain',
        message:
            'Enter a root domain for this CapRover server. For example, enter test.yourdomain.com if you' +
            ' setup your DNS to point *.test.yourdomain.com to ip address of your server.',
        filter: async (value: string) => {
            const captainRootDomainFromUser = value.trim()

            await updateRootDomain(captainRootDomainFromUser)

            return captainRootDomainFromUser
        },
    },
    {
        type: 'password',
        name: 'newPasswordFirstTry',
        message: 'Enter a new password (min 8 characters):',
        filter: (value: string) => {
            newPasswordFirstTry = value

            if (!newPasswordFirstTry) {
                StdOutUtil.printError('Password empty.', true)
                throw new Error('Password empty')
            }

            if (newPasswordFirstTry.length < 8) {
                StdOutUtil.printError('Password too small.', true)
                throw new Error('Password too small')
            }

            return value
        },
    },
    {
        type: 'password',
        name: 'newPassword',
        message: 'Enter your new password again:',
        filter: async (value: string) => {
            const confirmPasswordValueFromUser = value

            if (newPasswordFirstTry !== confirmPasswordValueFromUser) {
                StdOutUtil.printError(
                    'Passwords do not match. Try serversetup again.',
                    true
                )
                throw new Error('Password mismatch')
            }

            return ''
        },
    },
    {
        type: 'input',
        name: 'emailForHttps',
        message: "Enter your 'valid' email address to enable HTTPS: ",
        filter: async (value: string) => {
            const emailAddressFromUser = value.trim()

            await enableSslAndChangePassword(emailAddressFromUser)

            return emailAddressFromUser
        },
    },
    {
        type: 'input',
        name: 'captainName',
        message: 'Enter a name for this CapRover machine:',
        default: CliHelper.get().findDefaultCaptainName(),
        validate: (value: string) => {
            const newMachineName = value.trim()

            return getErrorForMachineName(newMachineName)
        },
    },
]

async function serversetup(options: any) {
    StdOutUtil.printMessage('\nSetup your CapRover server\n')

    if (!options.configFile) {
        const answersIgnore = await inquirer.prompt(questions)
    } else {
        const filePath = (options.configFile || '').startsWith('/')
            ? options.configFile
            : join(process.cwd(), options.configFile)
        // read config file and parse it.
        // validate IP, captainMachineName, emailAddress, newPassword, oldPassword(?), baseUrl

        if (!pathExistsSync(filePath))
            StdOutUtil.printError('File not found: ' + filePath, true)

        const fileContent = readFileSync(filePath, 'utf8').trim()

        let data: IServerSetupParams

        if (fileContent.startsWith('{') || fileContent.startsWith('[')) {
            data = JSON.parse(fileContent)
        } else {
            data = yaml.safeLoad(fileContent)
        }

        const errorForMachine = getErrorForMachineName(data.machineName)
        if (errorForMachine && errorForMachine !== true) {
            StdOutUtil.printError(errorForMachine, true)
        }

        captainMachine.authToken =
            (await getAuthTokenFromIp(data.ipAddress)) || ''
        if (!captainMachine.authToken) {
            await tryNewPassword(data.currentPassword!)
        }
        await updateRootDomain(data.rootDomain)
        newPasswordFirstTry = data.newPassword
        await enableSslAndChangePassword(data.emailForHttps)
    }

    StorageHelper.get().saveMachine(captainMachine)

    StdOutUtil.printMessage(
        `\n\nCapRover is available at ${captainMachine.baseUrl}`
    )

    StdOutUtil.printMessage(
        '\nFor more details and docs see http://www.CapRover.com\n\n'
    )
}

export default serversetup
