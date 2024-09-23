const axios = require('axios');
const Instance = require('../models/instanceModel')
const {Message, Contact, ChatLogs} = require('../models/chatModel');
const Campaign = require('../models/campaignModel');
const Event = require('../models/event.Model');
const User = require('../models/user');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs')
const { getCachedData } = require('../middlewares/cache');
const moment = require('moment-timezone');
const handlebars = require('handlebars');
const csv = require('csvtojson');
const dataKey = 'activeSet';
const xlsx = require('xlsx');
const pdf = require('html-pdf');
const path = require('path');

const saveContact = async(req, res)=>{
    try {
      const { name, number, instanceId, eventId, param1, param2, param3, days } = req.body;

      const existingContact = await Contact.findOne({
        eventId,
        $or: [
          { name },
          { number }
        ]
      });
  
      if (existingContact) {
        let errorMessage = 'Contact already exists with the same ';
        const errors = [];
        if (existingContact.name === name) errors.push('name');
        if (existingContact.number === number) errors.push('number');

        errorMessage += errors.join(' or ') + '.';

        return res.status(400).send({ error: errorMessage });
      } 

      const newDays  = days.map((ele)=> ({...ele, invitesAccepted: ele.invitesAccepted || 0}))
      const contact = new Contact({
        name,
        number,
        instanceId,
        eventId,
        param1,
        param2,
        param3,
        days: newDays,
        createdBy: req.user.userId
      });

        await contact.save();
        return res.status(201).send(contact);
      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const saveContactsInBulk = async(req, res) => {
  try {
    const filePath = req.file.path;
    const {instanceId, eventId} = req.body;

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

    const headers = sheet[0];
    const rows = sheet.slice(1)

    const event = await Event.findOne({ _id: eventId });

    const contacts = rows.map(row => {
      let contact = {
        name: row[headers.indexOf('name')],
        number: row[headers.indexOf('number')],
        days: [],
        createdBy: req.user.userId,
        instanceId: instanceId || null,
        eventId: eventId || null,
      };
            // Map day-wise invites
        for (let i = 1; i <= event.subEventDetails.length ; i++) {
          const dayInvite = row[headers.indexOf(`day${i}`)];
          if (dayInvite) {
            contact.days.push({
              invitesAllocated: dayInvite,
              invitesAccepted: 0, // Initial value, can be updated later
              inviteStatus: 'Pending', // Default status
            });
          }else{
            contact.days.push({
              invitesAllocated: 0,
              invitesAccepted: 0, // Initial value, can be updated later
              inviteStatus:'', // Default status
            });
          }
        }
  
        return contact;
      });

    await Contact.insertMany(contacts);

    res.status(201).json({ message: 'Contacts saved successfully' });
  } catch (error) {
    console.log(error)
    res.status(500).json({ error: 'An error occurred while saving contacts' });
  }
}

const getContact = async(req, res)=>{
    try {
      let query = {};
      const { page = 1, limit = 10, searchtext, eventId, filter, day ,inviteStatus} = req.query;

      if (eventId) {
        query.eventId = eventId;
      }
      
      if (searchtext) {
        query.$or = [
          { name: { $regex: new RegExp(searchtext, 'i') } },
          { number: { $regex: new RegExp(searchtext, 'i') } }
        ];
      }

      if (day) {
        const dayIndex = parseInt(day);
  
        // Check for contacts with invitesAllocated not equal to 0 for that day
        query[`days.${dayIndex}.invitesAllocated`] = { $ne: 0 };
  
        // If filter (status) is also provided, filter by inviteStatus for that day
        if (filter) {
          query[`days.${dayIndex}.inviteStatus`] = filter;
        }
      } else if (filter) {
        // If no day is provided but filter (status) is, filter by overAllStatus
        query.overAllStatus = filter;
      }
      if(inviteStatus){
        query.inviteMessageStatus = inviteStatus;
      }

      console.log({query})
      const Contacts = await Contact.find(query)
        .skip((page - 1) * limit)
        .limit(limit);

      const count = await Contact.countDocuments(query)

      return res.status(200).json({data: Contacts, total: count});

      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const updateContacts = async(req, res)=>{
    try {
        const { id } = req.params;
        const { isAdmin, name, number, instanceId, eventId, param1, param2, param3, days } = req.body;

        // Find the contact and update its data, including days
        const contact = await Contact.findByIdAndUpdate(
          id,
          {
            name,
            number,
            instanceId,
            eventId,
            param1,
            param2,
            param3,
            days,
            isAdmin,
            updatedAt: new Date()
          },
          { new: true }
        );

        if (!contact) {
          return res.status(404).send({ message: 'Contact not found' });
        }

        res.status(200).send(contact);
      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const getMessages = async (req, res)=>{
    try {
        const {senderNumber, instanceId, limit = 20, offset = 0 } = req.body;
        
        const instance = await Instance.findOne({_id:instanceId})

        const senderId = req.user.userId;
        
        // console.log(senderNumber, instance?.instance_id)
        // console.log(senderId)

        const messages = await Message.find({ 
          senderNumber: ''+ senderNumber,
          instanceId: instance.instance_id     
         }).sort({ createdAt: -1 })
         .skip(offset * limit)
         .limit(limit);

         const count = await Message.countDocuments({
          senderNumber: ''+ senderNumber,
          instanceId: instance.instance_id 
         })
        res.status(200).send({messages,count});
      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}


const processContact = async (number, instance, campaign, messageTrack,  message, media, mime, messageType) => {

  const sendMessageObj = {
    number: number,
    type: 'text',
    instance_id: instance?.instance_id,
  };
  let reply = message;
  let inviteMedia = {}
  if (media) {
    inviteMedia.filename = media.split('/').pop();
    inviteMedia.media_url = process.env.IMAGE_URL + media;
    inviteMedia.type = 'media';
  }
   // Handling custom message type - only send message and return
   await sendMessageFunc({ ...sendMessageObj, ...inviteMedia, message: reply });
   if (messageType === 'custom') {
    return; // Do nothing else for custom type
  }

    // For 'invite' messageType
    const contact = await Contact.findOne({ number, eventId: campaign?._id });

    // Check if there's an invite pending for the contact
  const index = contact.days.findIndex(
    (ele) => ele.invitesAllocated && ele.invitesAllocated !== '0'
  );

  const inviteToSend = index !== -1 ? contact.days[index] : null;
  const eventToInvite = campaign.subEventDetails[index];
  let subEventMedia = {}

  if (inviteToSend && eventToInvite) {
    // Reform data for invitation message
    const reformData = {
      ...inviteToSend?.toObject(),
      ...contact?.toObject(),
    };

    if (eventToInvite?.media) {
      subEventMedia.filename = eventToInvite?.media.split('/').pop();
      subEventMedia.media_url = process.env.IMAGE_URL + eventToInvite?.media;
      subEventMedia.type = 'media';
    }

    reply = replacePlaceholders(eventToInvite.eventText, reformData);
  }

  const response = await sendMessageFunc({ ...sendMessageObj, ...subEventMedia, message: reply });
 // Update contact and chat log only if the messageType is 'invite'
 if (messageType === 'invite') {
   // Update the contact's overall status and day-specific details
   contact.overAllStatus = 'Pending';
   contact.hasCompletedForm = false;
   contact.inviteMessageStatus = 'Pending';

   contact.days = contact.days.map((day) => {
     if (day.invitesAllocated && day.invitesAllocated !== '0' || day.invitesAccepted !== '0') {
       day.inviteStatus = 'Pending';
       day.invitesAccepted = '0';
     }
     return day;
   });

    // Update or create a new chat log entry
    const previousChatLog = await ChatLogs.findOneAndUpdate(
      {
        senderNumber: number,
        instanceId: instance?.instance_id,
        eventId: campaign._id,
      },
      {
        $set: {
          messageTrack: messageTrack,
          finalResponse: '',
          isCompleted: false,
          inviteStatus: contact.overAllStatus,
          updatedAt: Date.now(),
        },
        $unset: {
          inviteIndex: 1,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    // Increment message track and update invite index
    previousChatLog['messageTrack']++;
    previousChatLog['inviteIndex'] = index;

    // Save updated contact and chat log
    await contact.save();
    await previousChatLog.save();

 }
}

const sendMessagesWithDelay = async (numbers, instance, campaign, messageTrack,  message, media, mime, messageType) => {
  for (let i = 0; i < numbers.length; i++) {
    await processContact(numbers[i], instance, campaign, messageTrack, message, media, mime, messageType);
    await new Promise(resolve => setTimeout(resolve, 7500)); // Delay of 7 seconds between each message
  }
};

const sendBulkMessage = async (req, res) => {
  try {
   
    const { instance_id, eventId, message, media, mime, number, filter, messageTrack , messageType} = req.body;
    const senderId = req.user.userId;
    const day = filter.day
    const status = filter.filter
    const inviteStatus = filter.inviteStatus

    let messageNumbers = number;

    const instance = await Instance.findOne({ _id: instance_id });
    const campaign = await Event.findOne({ _id: eventId });
    if(!number?.length){
      const contactQuery ={eventId: eventId}
      
      if (day) {
        const dayIndex = parseInt(day);
        contactQuery[`days.${dayIndex}.invitesAllocated`] = { $ne: 0 };
        if (status) {
          contactQuery[`days.${dayIndex}.inviteStatus`] = status;
        }
      } else if (status) {
        contactQuery.overAllStatus = status;
      }
      if(inviteStatus){
        contactQuery.inviteMessageStatus = inviteStatus;
      }

      const contacts = await Contact.find(contactQuery);
      
      messageNumbers = contacts.map(contact => contact.number);
    }

    // Run the message sending task asynchronously
    sendMessagesWithDelay(messageNumbers, instance, campaign, messageTrack, message, media, mime, messageType)
      .then(() => {
        console.log('All messages sent');
      })
      .catch(error => {
        console.error('Error sending messages:', error);
      });

    // Send an immediate response to the client
    return res.status(201).send({ message: 'Message sending job queued' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
};

const sendMessages = async (req, res)=>{
  try {

    const { numbers, instance_id, eventId, message, messageTrack, messageType } = req.body;

    const senderId = req.user.userId
    const instance = await Instance.findOne({_id:instance_id})
    
    let start = new Date();
    start.setHours(0,0,0,0);

    let end = new Date();
    end.setHours(23,59,59,999);
    console.log('numbers', numbers)
    const campaign = await Event.findOne({_id: eventId})
    for(let number of numbers){
      console.log('number',number)
      const sendMessageObj={
        number: number,
        type: 'text',
        instance_id: instance?.instance_id,
      }

      const updateContact = await Contact.findOne({number, eventId })
      // console.log(updateContact)
  
      if(messageType==='invite'){
        updateContact.inviteStatus='Pending',
        updateContact['inviteMessageStatus'] = 'Pending',
        updateContact.updatedAt = Date.now()
        await updateContact.save()
      }else if(messageType==='accept'){
        updateContact.updatedAt = Date.now()
        updateContact.inviteStatus='Accepted',
        await updateContact.save()
      }else if(messageType==='rejection'){
        updateContact.updatedAt = Date.now()
        updateContact.inviteStatus='Rejected',
        await updateContact.save()
      }
  
      if(messageTrack==1){
  
        let reply = campaign?.invitationText
        if(campaign?.invitationMedia){              
          sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
          sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
          sendMessageObj.type = 'media';
        }
        const response = await sendMessageFunc({...sendMessageObj,message: reply });
        const NewChatLog = await ChatLogs.findOneAndUpdate(
          {
            senderNumber: number,
            instanceId: instance?.instance_id,
            eventId : campaign._id,
            messageTrack:  1
          },
          {
            $set: {
              updatedAt: Date.now(),
            }
          },
          {
            upsert: true, // Create if not found, update if found
            new: true // Return the modified document rather than the original
          }
        )
      }else{
        const NewChatLog = await ChatLogs.findOneAndUpdate(
          {
            senderNumber: number,
            instanceId: instance?.instance_id,
            eventId : campaign._id,
          },
          {
            $set: {
              messageTrack:  messageTrack,
              inviteStatus : updateContact.inviteStatus,
              updatedAt: Date.now(),
            }
          },
          {
            upsert: true, // Create if not found, update if found
            new: true // Return the modified document rather than the original
          }
        )
        const response = await sendMessageFunc({...sendMessageObj,message });

      }
    }
   
    return res.status(201).send({message:'mesg sent'});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.data });
  }
}

const recieveMessagesV2 = async (req, res)=>{
  try{
    const messageObject = req.body;
    // console.log(req.body?.data?.event)
    // if(messageObject.data?.data?.messages?.[0]?.key?.fromMe === true) return res.send()
    if(["messages.upsert"].includes(req.body?.data?.event)){
      let message;
      message = messageObject.data.data.messages?.[0]?.message?.extendedTextMessage?.text || messageObject.data.data.messages?.[0]?.message?.conversation || '';
      let remoteId = messageObject.data.data.messages?.[0]?.key.remoteJid.split('@')[0];

      let fromMe = messageObject.data.data.messages?.[0]?.key?.fromMe
      let messageId = messageObject.data.data.messages?.[0]?.key?.id
      let timeStamp = messageObject.data.data.messages?.[0]?.messageTimestamp

      if(isNaN(remoteId.length)||remoteId.length>13){
        return res.send('invalid number')
      }

      const now = new Date();

      let start = new Date();
      start.setHours(0,0,0,0);

      let end = new Date();
      end.setHours(23,59,59,999);

      const recieverId = await Instance.findOne({instance_id: messageObject.instance_id})
      const senderId = await Contact.findOne({number: remoteId, eventId: recieverId?.eventId })

      if(!senderId) return res.send('No contacts in db');
      
      const currentTime = new Date();
      currentTime.setHours(currentTime.getHours() + 2);
      const updatedTimeISO = currentTime.toISOString();
      
      const previMessage = await Message.findOne({
        senderNumber: remoteId,
        recieverId : recieverId?._id,
        eventId: recieverId?.eventId,
        fromMe: false
      }).sort({createdAt: -1})

      const newMessage = {
        recieverId : recieverId?._id,
        senderNumber: remoteId,
        instanceId: messageObject?.instance_id,
        eventId: recieverId?.eventId,
        fromMe: fromMe,
        text: message,
        type: 'text',
        messageId,
        timeStamp: updatedTimeISO
      }

      const savedMessage = new Message(newMessage);
      await savedMessage.save();

      const sendMessageObj={
        number: remoteId,
        type: 'text',
        instance_id: messageObject?.instance_id,
      }

      const tempEvent = await Event.findOne({_id: senderId.eventId})

      // generates Report
      if(message.toLowerCase()===tempEvent?.ReportKeyword && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');
        const events = tempEvent.subEventDetails.map((ele)=>ele.eventName)

        const fileName = await getReportdataByTime(start,end, recieverId?._id, tempEvent?._id ,events)
        // console.log('fileName', fileName)
        // const fileName = 'http://5.189.156.200:84/uploads/reports/Report-1716394369435.csv'
        sendMessageObj.filename = fileName.split('/').pop();
        sendMessageObj.media_url= process.env.IMAGE_URL+fileName;
        sendMessageObj.type = 'media';
        const response =  await sendMessageFunc({...sendMessageObj, message:'Download report'});
        return res.send(true);
      }

      //generate Report Dump
      if(message.toLowerCase()==='report dump' && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');

        const fileName = await getFullReport(start,end, recieverId?._id, tempEvent?._id ,rejectregex)
        // console.log('fileName', fileName)
        // const fileName = 'http://5.189.156.200:84/uploads/reports/Report-1716394369435.csv'
        sendMessageObj.filename = fileName.split('/').pop();
        sendMessageObj.media_url= process.env.IMAGE_URL+fileName;
        sendMessageObj.type = 'media';
        const response =  await sendMessageFunc({...sendMessageObj, message:'Download report dump'});
        return res.send(true);
      }
      
      // Gives Stats
      if(message.toLowerCase()===tempEvent?.StatsKeyword && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }

        const replyObj = await getDayStats(tempEvent?._id);

        let replyMessage = '*Statistics*';
        replyMessage += '\n';
        // replyMessage += `\n› Total nos of Invitees: *${replyObj?.totalContacts}*`;
        // replyMessage += `\n› Yes: *${replyObj?.totalYesContacts}*`;
        // replyMessage += `\n› No: *${replyObj?.totalNoContacts}*`;
        // replyMessage += `\n› Balance: *${replyObj?.totalLeft}*`;

        replyMessage += '\n\n*Day-wise Breakdown*\n';

        const sortedDays = Object.keys(replyObj?.dayStats || {}).sort((a, b) => {
          const dayA = parseInt(a.split('_')[1], 10);
          const dayB = parseInt(b.split('_')[1], 10);
          return dayA - dayB;
        });      

        sortedDays.forEach((day, i) => {
          const stats = replyObj.dayStats[day];
          replyMessage += `\n*${tempEvent.subEventDetails[i]?.eventName}*:\n`;
          replyMessage += `  - Accepted: *${stats?.yes}*\n`;
          replyMessage += `  - Rejected: *${stats?.no}*\n`;
          replyMessage += `  - Pending: *${stats?.pending}*\n`;
          replyMessage += `  - Total Guests Count: *${stats?.totalAccepted}*\n`;
        });
        
        const response = await sendMessageFunc({...sendMessageObj, message: replyMessage});
        return res.send(true);
      }

      // Saves New Contact
      if(message.toLowerCase() === `${tempEvent.initialCode}/${tempEvent?.newContactCode}` && senderId?.isAdmin){
        // console.log('message', message)
        let reply = 'Send new contact detail in following pattern.\nYou can copy the next message and send it again with your contact details';
        let Newreply = 'New_Contact\n'
        Newreply += '\nName: John Doe'
        Newreply += '\nInvites: 1/2/3/all'
        Newreply += '\nISD code: 91'
        Newreply += '\nNumber: 9999999999'
        Newreply += '\nParam1: '
        Newreply += '\nParam2: '
        Newreply += '\nParam3: '

        const response1 = await sendMessageFunc({...sendMessageObj,message: reply });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response2 = await sendMessageFunc({...sendMessageObj,message: Newreply });

        return res.send('not a valid code')
      }
     
       // Saves New Contact Demo Message Prompt
      if (previMessage && previMessage.text.toLowerCase() === `${tempEvent.initialCode}/${tempEvent?.newContactCode}` && senderId?.isAdmin && !newMessage.fromMe) {
        // console.log('new_contact', message.split('\n')[0].toLowerCase())
        if (message.split('\n')[0].toLowerCase() === 'new_contact') {
          const result = {};
          const lines = message.split('\n');
          // console.log('split', lines);
      
          lines.slice(2).forEach(item => {
            let [key, value] = item.split(':').map(part => part.trim());
            key = key.toLowerCase().replace(/ /g, ''); // Normalize key
      
            if (key === 'name') {
              result.name = value || null;
            } else if (key === 'invites') {
              result.invites = value || null;
            } else if (key === 'isdcode') {
              result.isdCode = value || '';
            } else if (key === 'number') {
              result.number = (result.isdCode ? result.isdCode : '') + (value || '');
            } else {
              result[key] = value || null;
            }
          });
      
          result['createdBy'] = senderId?._id;
          result['instanceId'] = recieverId?._id || null;
          result['eventId'] = recieverId?.eventId;
          result['inviteStatus'] = 'Pending';
      
          const { name, number } = result; // Extract name and number from result
      
          const existingContact = await Contact.findOne({
            eventId: recieverId?.eventId,
            $or: [
              { name },
              { number }
            ]
          });
      
          if (existingContact) {
            let errorMessage = 'Contact already exists with the same ';
            const errors = [];
            if (existingContact.name === name) errors.push('name');
            if (existingContact.number === number) errors.push('number');
      
            errorMessage += errors.join(' or ') + '.';
            const response = await sendMessageFunc({...sendMessageObj,message: errorMessage });
            return res.status(400).send({ error: errorMessage });
          }
      
          const contact = new Contact(result);
          await contact.save(); // Ensure the save operation is performed
          const response = await sendMessageFunc({...sendMessageObj,message: 'Contact saved' });
          return res.status(201).send('contact');
        }
      }

      const previousChatLog = await ChatLogs.findOne(
        {
          senderNumber: remoteId,
          instanceId: messageObject?.instance_id,
          eventId: senderId.eventId
        },
      ).sort({ updatedAt: -1 });

      if(fromMe) {
        const campaign = await Event.findOne({_id: recieverId?.eventId})
        const code = message.split('/') 
        if(code[0].toLowerCase() === campaign.initialCode.toLowerCase()){
          const codeType = code[1].toLowerCase()

          if(codeType === campaign.inviteCode){

            let reply = campaign?.invitationText
            let inviteMedia = {}
            if(campaign?.invitationMedia){              
              inviteMedia.filename = campaign?.invitationMedia.split('/').pop();
              inviteMedia.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
              inviteMedia.type = 'media';
            }
            senderId.hasCompletedForm = false;
            senderId.overAllStatus = 'Pending'
            senderId.lastResponse = '';
            senderId.updatedAt = Date.now();
            senderId.lastResponseUpdatedAt= Date.now();
            senderId.days = senderId.days.map((day) => {
              if (day.invitesAllocated && day.invitesAllocated !== '0') {
                day.inviteStatus = 'Pending'; // Reset to Pending
                day.invitesAccepted = '0'; // Reset to 0
              }
              return day;
            });

            await senderId.save()

            const response = await sendMessageFunc({...sendMessageObj,...inviteMedia,message: reply });

            const index = senderId.days.findIndex(
              (ele) => ele.invitesAllocated && ele.invitesAllocated !== '0'
            );
          
            const inviteToSend = index !== -1 ? senderId.days[index] : null;
            const eventToInvite = campaign.subEventDetails[index];
          
            if (inviteToSend && eventToInvite) {
              const reformData = {
                ...inviteToSend?.toObject(),
                ...senderId?.toObject(),
              };
            
              let subEventMedia = {}
              if (eventToInvite?.media) {
                subEventMedia.filename = eventToInvite?.media.split('/').pop();
                subEventMedia.media_url = process.env.IMAGE_URL + eventToInvite?.media;
                subEventMedia.type = 'media';
              }
            
              reply = replacePlaceholders(eventToInvite.eventText, reformData);
            
              const response = await sendMessageFunc({ ...sendMessageObj, ...subEventMedia, message: reply });
            }

            const NewChatLog = await ChatLogs.findOneAndUpdate(
              {
                senderNumber: remoteId,
                instanceId: messageObject?.instance_id,
                eventId : campaign._id,
              },
              {
                $set: {
                  inviteStatus: 'Pending',
                  messageTrack: 2,
                  inviteIndex: index,
                  isCompleted: false,
                  updatedAt: Date.now(),
                }
              },
              {
                upsert: true, // Create if not found, update if found
                new: true // Return the modified document rather than the original
              }
            )

            return res.send('invitemessageSend')

          } 
          else if(codeType === campaign.acceptCode){

            const dayIndex = code[2]; // e.g., 1 (if exists)
            const inviteCount = code[3];
            if(campaign?.thankYouMedia){              
              sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
              sendMessageObj.type = 'media';
            }
            let reply = campaign?.acceptanceAcknowledgment
            if(campaign?.thankYouMedia){              
              sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
              sendMessageObj.type = 'media';
            }

            senderId['overAllStatus'] = 'Accepted';
            if(dayIndex){
              const invitedDay = senderId.days[+dayIndex-1];
              const nextInvite = senderId.days.findIndex(
                (ele, index) => index > +dayIndex - 1 && ele.invitesAllocated && ele.inviteStatus === 'Pending'
              );
              if(inviteCount){
                senderId.days[+dayIndex-1].invitesAccepted = inviteCount
                senderId.days[+dayIndex-1].inviteStatus = 'Accepted'
                if(nextInvite !== -1){

                  previousChatLog['inviteIndex'] = nextInvite;
                  const inviteToSend = senderId.days[nextInvite];
                  const eventToInvite = campaign.subEventDetails[nextInvite]
                  if(eventToInvite?.media){              
                    sendMessageObj.filename = eventToInvite?.media.split('/').pop();
                    sendMessageObj.media_url= process.env.IMAGE_URL+eventToInvite?.media;
                    sendMessageObj.type = 'media';
                  }

                  reply = eventToInvite?.eventText
                }else{
                  previousChatLog['inviteIndex'] = campaign.subEventDetails.length;
                  previousChatLog['isCompleted'] = true;
                  previousChatLog['messageTrack'] = 3;
                  
                  senderId['hasCompletedForm'] = true;


                  reply = campaign?.acceptanceAcknowledgment
                }

              }else{
                 if(invitedDay.invitesAllocated == 1){
                  senderId.days[+dayIndex-1].invitesAccepted = senderId.days[+dayIndex-1].invitesAllocated
                  senderId.days[+dayIndex-1].inviteStatus = 'Accepted'
                  
                  if(nextInvite){
                    previousChatLog['inviteIndex'] = nextInvite;
                    reply = eventToInvite?.eventText;
                  }else{
                    previousChatLog['inviteIndex'] = dayIndex;
                    previousChatLog['isCompleted'] = true;
                    previousChatLog['messageTrack'] = 3;
                    
                    senderId['hasCompletedForm'] = true;

                    reply = campaign?.acceptanceAcknowledgment
                  }

                 } else {
                  previousChatLog['inviteIndex'] = +dayIndex-1;
                  previousChatLog['messageTrack'] = 2;
                  senderId.days[+dayIndex-1].invitesAccepted = 0
                  senderId.days[+dayIndex-1].inviteStatus = 'Pending'
                  senderId['hasCompletedForm'] = true;
                  reply = campaign?.messageForMoreThanOneInvites;
                 }
              }

            }else{
              senderId.days = senderId.days.map((day) => {
                if (day.invitesAllocated && day.invitesAllocated !== '0') {
                  day.inviteStatus = 'Accepted';
                  if (day.invitesAllocated.toLowerCase() === 'all') {
                    day.invitesAccepted = '5';
                  } else {
                    day.invitesAccepted = day.invitesAllocated; 
                  }
                }
                return day;
              });
              
              senderId.overAllStatus = 'Accepted';
              senderId.hasCompletedForm = true;
            
              previousChatLog.messageTrack = 3;
              previousChatLog.inviteIndex = senderId.days.length;
              previousChatLog.isCompleted = true;
              previousChatLog.finalResponse = message;
              previousChatLog.inviteStatus = 'Accepted';
              previousChatLog.updatedAt = Date.now();
            }

             
            const inviteToSend = senderId.days[previousChatLog['inviteIndex']];
            const eventToInvite = campaign.subEventDetails[previousChatLog['inviteIndex']]
  
            reformData={
              ...inviteToSend?.toObject(),
              ...senderId?.toObject(),
              }
  

            reply = replacePlaceholders(reply, reformData)
            const response = await sendMessageFunc({ ...sendMessageObj, message: reply });
              
            await previousChatLog.save()
            await senderId.save();
            return res.send('acceptMessageSent')

          } 
          else if(codeType === campaign.rejectCode) {
            previousChatLog['messageTrack'] = 3;
            previousChatLog['finalResponse'] = message.toLowerCase();
            previousChatLog.updatedAt = Date.now();
            let reply = campaign?.rejectionAcknowledgment;

            const dayIndex = code[2]; // e.g., 1 (if exists)
            const inviteCount = code[3]; // e.g., number of invites to reject

           if (dayIndex) {
           // Day-specific rejection logic
           const invitedDay = senderId.days[+dayIndex - 1];

           if (inviteCount) {
            // Reducing the invitesAccepted count for the specified day
            const invitesAcceptedNum = parseInt(invitedDay.invitesAccepted || '0', 10);
            const inviteCountNum = parseInt(inviteCount, 10);

            invitedDay.invitesAccepted = (invitesAcceptedNum - inviteCountNum).toString();

            if (parseInt(invitedDay.invitesAccepted, 10) <= 0) {
                invitedDay.invitesAccepted = '0';
                invitedDay.inviteStatus = 'Rejected'; // Fully rejected
				
            } else {
                invitedDay.inviteStatus = 'Accepted'; // Still accepted if invites remain
            }
          } else {
            // If no invite count provided, fully reject the invites for the specified day
            invitedDay.invitesAccepted = '0';
            invitedDay.inviteStatus = 'Rejected';
           }

           senderId.days[+dayIndex - 1] = invitedDay; // Update the day status
		    const hasRemainingAcceptedOrPending = senderId.days.some(day => 
             day.inviteStatus === 'Accepted' || day.inviteStatus === 'Pending'
          );

          if (!hasRemainingAcceptedOrPending) {
             senderId.overAllStatus = 'Rejected'; // No accepted or pending invites left, set overAllStatus to 'Rejected'
          }
         } else {
        // Rejection for all days
          senderId.days = senderId.days.map(day => {
            if (day.invitesAllocated && day.invitesAllocated !== '0') {
                day.inviteStatus = 'Rejected';
                day.invitesAccepted = '0'; // Set all invitesAccepted to 0
            }
            return day;
		   });

        senderId.overAllStatus = 'Rejected';
        senderId.hasCompletedForm = true;
    }

    // Update previousChatLog for inviteIndex and status
    previousChatLog.inviteStatus = 'Rejected';
    previousChatLog.isCompleted = true;

    senderId.lastResponse = message;
    senderId.lastResponseUpdatedAt = Date.now();

    await senderId.save();
    await previousChatLog.save();

    // Send response with rejection acknowledgment
    const response = await sendMessageFunc({ 
        ...sendMessageObj, 
        message: reply 
    });

    return res.send('rejectMessageSent');
          }
        }
        return res.send('nothing')
      }

      let reply;

      if(!previousChatLog){
        const campaignData = await Event.find({_id: recieverId.eventId})
        console.log({campaignData})
        for (let campaign of campaignData){
          let contact;
          if(true){
            contact = await Contact.findOne({number: remoteId, eventId: campaign?._id.toString()})
            // console.log({contact})
            if(!contact) {
              // reply = campaign.numberVerificationFails;
              // const response = await sendMessageFunc({...sendMessageObj,message: reply });
              return res.send('Account not found')
            }
          }
          if(campaign.startingKeyword && campaign.startingKeyword.toLowerCase() === message.toLowerCase()){
            const currentTime = moment();
           
            const startingTime = moment(campaign.startDate)
            .set('hour', campaign.startHour)
            .set('minute', campaign.startMinute);
      
          const endingTime = moment(campaign.endDate)
            .set('hour', campaign.endHour)
            .set('minute', campaign.endMinute);

            if (!currentTime.isBetween(startingTime, endingTime)) {
              const response =  await sendMessageFunc({...sendMessageObj,message: campaign?.messageForClosedInvitations });
              return res.send(true);      
            }
            let reply = campaign?.invitationText
            if(campaign?.invitationMedia){              
              sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
              sendMessageObj.type = 'media';
            }
            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            const NewChatLog = await ChatLogs.findOneAndUpdate(
              {
                senderNumber: remoteId,
                instanceId: messageObject?.instance_id,
                updatedAt: { $gte: start, $lt: end },
                eventId : campaign._id,
                messageTrack:  1
              },
              {
                $set: {
                  updatedAt: Date.now(),
                  isValid: contact? true: false
                }
              },
              {
                upsert: true, // Create if not found, update if found
                new: true // Return the modified document rather than the original
              }
            )
            return res.send('firstMessage sent')
          }
        }
        return res.send('No active campaign found')
       
      }

      const campaign = await Event.findOne({_id: previousChatLog?.eventId})

      if(campaign?.RewriteKeyword?.toLowerCase() === message?.toLowerCase()){
        if(!previousChatLog || previousChatLog.messageTrack===1){
          const response =  await sendMessageFunc({...sendMessageObj,message: 'Nothing to cancel' });
          return res.send(true);
        }
        previousChatLog['messageTrack']=2

        previousChatLog['finalResponse']=''
        previousChatLog['inviteStatus']='Pending'
		    previousChatLog['isCompleted']=false;
		
        if(true){
          senderId.lastResponse = '';
          senderId.lastResponseUpdatedAt= Date.now();
          senderId.overAllStatus ='Pending';
          senderId.hasCompletedForm = false;
          senderId.days = senderId.days.map((day) => {
              if (day.invitesAllocated && day.invitesAllocated !== '0') {
                day.inviteStatus = 'Pending'; // Reset to Pending
                day.invitesAccepted = '0'; // Reset to 0
              }
              return day;
            });
		
        }
        let reply = campaign?.invitationText
        let inviteMedia = {}
          if(campaign?.invitationMedia){              
            inviteMedia.filename = campaign?.invitationMedia.split('/').pop();
            inviteMedia.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
            inviteMedia.type = 'media';
          }
        const response =  await sendMessageFunc({...sendMessageObj, ...inviteMedia, message: reply });

        const index = senderId.days.findIndex(
          (ele) => ele.invitesAllocated && ele.invitesAllocated !== '0'
        );
        previousChatLog['inviteIndex'] = index;
        const inviteToSend = index !== -1 ? senderId.days[index] : null;
        const eventToInvite = campaign.subEventDetails[index];
      
        if (inviteToSend && eventToInvite) {
          // Reform data for invitation message
          const reformData = {
            ...inviteToSend?.toObject(),
            ...senderId?.toObject(),
          };
        
          // Check if the event has associated media and update sendMessageObj accordingly
          let subEventMedia = {};
          if (eventToInvite?.media) {
            subEventMedia.filename = eventToInvite?.media.split('/').pop();
            subEventMedia.media_url = process.env.IMAGE_URL + eventToInvite?.media;
            subEventMedia.type = 'media';
          }
        
          // Replace placeholders with reform data in the message template
          reply = replacePlaceholders(eventToInvite.eventText, reformData);
        
          const response = await sendMessageFunc({ ...sendMessageObj, ...subEventMedia, message: reply });
        }
        await senderId.save();
        await previousChatLog.save()

        return res.send('after change message')
      }

      if(previousChatLog['messageTrack']>0){
        const contact =  await Contact.findOne({number: remoteId, eventId: campaign?._id.toString()})
        // if(contact.hasCompletedForm){
        //   const updatedAtTime = new Date(previousChatLog.updatedAt).getTime(); // convert updatedAt to milliseconds
        //   const currentTime = now.getTime(); // current time in milliseconds
        //   if (currentTime - updatedAtTime <= 3600000) {
        //     console.log("Within 1 hour of session");
        //   } else {
        //     return res.send('');
        //   }
        // }
        
        const acceptregex = new RegExp(`\\b${campaign.acceptanceKeyword}\\b`, 'i');
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');
        
        if(previousChatLog['messageTrack'] === 1 && acceptregex.test(message.trim())){
          console.log('step 1')
            const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.invitesAllocated!='0' && ele.inviteStatus === 'Pending');
            const inviteToSend = index !== -1 ? contact.days[index] : null;
            const eventToInvite = campaign.subEventDetails[index]
  
            reformData={
              ...inviteToSend?.toObject(),
              ...contact?.toObject(),
              }

            if(eventToInvite?.media){              
              sendMessageObj.filename = eventToInvite?.media.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+eventToInvite?.media;
              sendMessageObj.type = 'media';
            }
            const reply = replacePlaceholders(eventToInvite.eventText, reformData)
            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            previousChatLog['messageTrack'] ++;
            previousChatLog['inviteStatus'] = 'Accepted';
            previousChatLog['inviteIndex'] = index;
  
            contact['overAllStatus'] = 'Accepted';
  
            await contact.save();
            await previousChatLog.save();
            return res.send('Type Change First')

        }
        else if(previousChatLog['messageTrack'] === 1 && rejectregex.test(message.trim())){
          console.log('step 2')
          const reply = replacePlaceholders(campaign.rejectionAcknowledgment, reformData)
          const response = await sendMessageFunc({...sendMessageObj,message: reply });
          previousChatLog['messageTrack']  ++;
          previousChatLog['inviteStatus'] = 'Rejected';
          previousChatLog['isCompleted'] = true;

          contact['hasCompletedForm'] = true;
          contact['overAllStatus'] = 'Rejected';

          await previousChatLog.save();
          await contact.save();
          return res.send('Type Change First')

        }
        else {
          if(campaign.hasSubEvent && previousChatLog['inviteIndex'] < campaign.subEventDetails.length){
            const dayInvite = contact.days[previousChatLog['inviteIndex']]

            if(acceptregex.test(message.trim())){
              if(dayInvite.invitesAllocated == 1){
                console.log('step 6')
                contact.days[previousChatLog['inviteIndex']].invitesAccepted = dayInvite.invitesAllocated;
                contact.days[previousChatLog['inviteIndex']].inviteStatus = 'Accepted';

                const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.invitesAllocated!='0' && ele.inviteStatus === 'Pending');
                const inviteToSend = index !== -1 ? contact.days[index] : null;
                const eventToInvite = campaign.subEventDetails[index]
      
                reformData={
                  ...inviteToSend?.toObject(),
                  ...contact?.toObject()
                  }
    
                  let reply
                  if(index != -1){
                    previousChatLog['inviteIndex'] = index;
                    if(eventToInvite?.media){              
                      sendMessageObj.filename = eventToInvite?.media.split('/').pop();
                      sendMessageObj.media_url= process.env.IMAGE_URL+eventToInvite?.media;
                      sendMessageObj.type = 'media';
                    }
                    reply = replacePlaceholders(eventToInvite.eventText, reformData)
                    await SendMessageWithoutReformText({...sendMessageObj,message: reply });

                  }else{
                    previousChatLog['inviteIndex'] ++;
                    previousChatLog['isCompleted'] = true;
                    contact['hasCompletedForm'] = true;
                    previousChatLog['messageTrack'] ++;
                    if(campaign?.thankYouMedia){              
                      sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
                      sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
                      sendMessageObj.type = 'media';
                    }
                    reply = replacePlaceholders(campaign.acceptanceAcknowledgment, reformData)
                    await SendMessageWithoutReformText({...sendMessageObj,message: reply });

                    let contactReformed = formatForSummary(contact , campaign)
                    let summary = replaceConditionalPlaceholders(campaign.summaryMessage, contactReformed)
                    await SendMessageWithoutReformText({...sendMessageObj,message: summary });                  }
                  
                  await previousChatLog.save();
                  await contact.save();
                  return res.send('sending invite message')
              }else{
                console.log('step 7')
                reformData={
                  ...dayInvite?.toObject(),
                  ...contact.days[previousChatLog['inviteIndex']]?.toObject(),
                  ...contact?.toObject()
                  }
                const reply = replacePlaceholders(campaign?.messageForMoreThanOneInvites, reformData)
                const response = await SendMessageWithoutReformText({...sendMessageObj,message: reply });
                return res.send('More Invites')
              }   
            }

            const numbersString = extractNumberOrAll(message.toLowerCase());
              function extractNumberOrAll(input) {
              const numberMatch = input.match(/\d+/);
              if (numberMatch) {
                return numberMatch[0];
              } else if (/\ball\b/i.test(input)) {
                return "all";
              } else {
                return null; // or any default value you want to return if neither is found
              }
            }
            if(numbersString !== null && (numbersString == dayInvite.invitesAllocated.toLowerCase() || (dayInvite.invitesAllocated.toLowerCase() === "all" || (!isNaN(numbersString) && +numbersString <= dayInvite.invitesAllocated)))){
              console.log('step 8')
              contact.days[previousChatLog['inviteIndex']].invitesAccepted = numbersString;
              contact.days[previousChatLog['inviteIndex']].inviteStatus = 'Accepted';
              previousChatLog['inviteStatus'] = 'Accepted';
              contact['overAllStatus'] = 'Accepted';

              const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.invitesAllocated!='0' && ele.inviteStatus === 'Pending');
              const inviteToSend = index !== -1 ? contact.days[index] : null;
              const eventToInvite = campaign.subEventDetails[index]
    
              reformData={
                ...inviteToSend?.toObject(),
                ...contact?.toObject()
                }
  
                let reply
                if(index != -1){
                  previousChatLog['inviteIndex'] = index;
                  if(eventToInvite?.media){              
                    sendMessageObj.filename = eventToInvite?.media.split('/').pop();
                    sendMessageObj.media_url= process.env.IMAGE_URL+eventToInvite?.media;
                    sendMessageObj.type = 'media';
                  }
                  reply = replacePlaceholders(eventToInvite.eventText, reformData)
                  await SendMessageWithoutReformText({...sendMessageObj,message: reply });
                }else{
                  previousChatLog['inviteIndex'] ++;
                  previousChatLog['isCompleted'] = true;
                  previousChatLog['messageTrack'] ++;
                  previousChatLog['inviteStatus'] = 'Accepted';
                  contact['hasCompletedForm'] = true;
                  contact['overAllStatus'] = 'Accepted';
                  if(campaign?.thankYouMedia){              
                    sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
                    sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
                    sendMessageObj.type = 'media';
                  }
                  reply = replacePlaceholders(campaign.acceptanceAcknowledgment, reformData)
                  await SendMessageWithoutReformText({...sendMessageObj,message: reply });

                  let contactReformed = formatForSummary(contact , campaign)
                  let summary = replaceConditionalPlaceholders(campaign.summaryMessage, contactReformed)
                  await SendMessageWithoutReformText({...sendMessageObj,message: summary });
                }

                await previousChatLog.save();
                await contact.save();
                return res.send('sending invite message')
            }else if(rejectregex.test(message.trim())){
              contact.days[previousChatLog['inviteIndex']].invitesAccepted = 0;
              contact.days[previousChatLog['inviteIndex']].inviteStatus = 'Rejected';
              const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.invitesAllocated!='0' && ele.inviteStatus === 'Pending');
              if(index==-1){
                let reply = campaign?.rejectionAcknowledgment
                const response = await sendMessageFunc({...sendMessageObj,message: reply }); 

                previousChatLog['inviteIndex'] = campaign?.subEventDetails.length;
                previousChatLog['isCompleted'] = true;
                previousChatLog['messageTrack'] ++;

                contact['hasCompletedForm'] = true;

                let contactReformed = formatForSummary(contact , campaign)
                let summary = replaceConditionalPlaceholders(campaign.summaryMessage, contactReformed)
                await SendMessageWithoutReformText({...sendMessageObj,message: summary });
                await contact.save();
                await previousChatLog.save();

                return res.send('acceptance send')
              }
              const inviteToSend = index !== -1 ? contact.days[index] : null;
              const eventToInvite = campaign.subEventDetails[index]
    
              reformData={
                ...inviteToSend?.toObject(),
                ...contact?.toObject()
                }
    
                let reply
                if(index != -1){
                  previousChatLog['inviteIndex'] = index;
                  if(eventToInvite?.media){              
                    sendMessageObj.filename = eventToInvite?.media.split('/').pop();
                    sendMessageObj.media_url= process.env.IMAGE_URL+eventToInvite?.media;
                    sendMessageObj.type = 'media';
                  }
                  reply = replacePlaceholders(eventToInvite.eventText, reformData)
                  const response = await SendMessageWithoutReformText({...sendMessageObj,message: reply });

                }else{
                  previousChatLog['inviteIndex'] ++;
                  previousChatLog['isCompleted'] = true;
                  previousChatLog['messageTrack'] ++;
                  contact['hasCompletedForm'] = true;
                  
                  reply = replacePlaceholders(campaign.rejectionAcknowledgment, reformData)
                  const response = await SendMessageWithoutReformText({...sendMessageObj,message: reply });

                  let contactReformed = formatForSummary(contact , campaign)
                  let summary = replaceConditionalPlaceholders(campaign.summaryMessage, contactReformed)
                  await SendMessageWithoutReformText({...sendMessageObj,message: summary });
                }
              await previousChatLog.save();
              await contact.save();
              return res.send('sending invite message')
            }
          }
        } 
      }

      // if(campaign?.RewriteKeyword?.toLowerCase() === message?.toLowerCase()){
      //   if(!previousChatLog || previousChatLog.messageTrack===1){
      //     const response =  await sendMessageFunc({...sendMessageObj,message: 'Nothing to cancel' });
      //     return res.send(true);
      //   }
      //   previousChatLog['messageTrack']=1
      //   previousChatLog['finalResponse']=''
      //   await previousChatLog.save()
      //   let reply = campaign?.invitationText
      //     if(campaign?.invitationMedia){              
      //       sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
      //       sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
      //       sendMessageObj.type = 'media';
      //     }
      //   const response =  await sendMessageFunc({...sendMessageObj,message: reply });
      //   return res.send('after change message')
      // }
      
      return res.send('nothing matched')
    }else if(["messages.update"].includes(req.body?.data?.event)){
      
      let data = messageObject.data.data
      for (const elem of data) {
        let messageId = elem.key?.id;
        let message = await Message.findOne({ messageId });
        if (!message) {
          continue;
        };

        const contact = await Contact.findOne({number: message.senderNumber, eventId: message.eventId})
        if(contact?.inviteMessageStatus!=='Readed'){
          console.log('status', elem.update?.status)
          contact['inviteMessageStatus']= elem.update?.status === 4?'Readed': 'Recieved';
          contact['updatedAt'] = Date.now();
          await contact.save()
        }
        
        let newStatus = {
          status: elem.update?.status,  // Replace with the actual status name
          time: new Date()            // Set the actual time or use a specific date
        };
    
        message.messageStatus.push(newStatus);
        await message.save();
        // console.log('message status Updated to '+ elem.update?.status+' for '+ message.text)
      }
      return res.send('status updated')
    }
    else{
      return res.send(false)
    }
  }catch (error){
    console.log(error)
    return res.status(500).json({ error: 'Internal server error' });
  }
}


const sendMessageFunc = async (message, data={})=>{
  const instance = await Instance.findOne({
    instance_id: message.instance_id
  }).sort({ updatedAt: -1 })

  const contact = await Contact.findOne({number: message.number, eventId: instance?.eventId.toString()});
  message.message = reformText(message?.message, {contact})
  
  const url = process.env.LOGIN_CB_API
  const access_token = process.env.ACCESS_TOKEN_CB
  if(message?.media_url){
    const newMessage = {
      ...message,
      senderNumber: message?.number,
      instanceId: message?.instance_id,
      fromMe: true,
      text: message?.message,
      media_url: message?.media_url,
      eventId: instance?.eventId
    }
    const savedMessage = new Message(newMessage);
    await savedMessage.save();
  }

  // console.log('aaaa',newMessage)

  const response = await axios.get(`${url}/send`,{params:{...message,access_token}})
  // console.log(response)
  return true;
}

const SendMessageWithoutReformText = async(message)=>{
  const url = process.env.LOGIN_CB_API
  const access_token = process.env.ACCESS_TOKEN_CB
  if(message?.media_url){
    const newMessage = {
      ...message,
      senderNumber: message?.number,
      instanceId: message?.instance_id,
      fromMe: true,
      text: message?.message,
      media_url: message?.media_url,
      eventId: instance?.eventId
    }
    const savedMessage = new Message(newMessage);
    await savedMessage.save();
  }
  const response = await axios.get(`${url}/send`,{params:{...message,access_token}})
  // console.log(response)
  return true;
}

const reformText = (message, data)=>{
  const {contact, chatLog} = data;
  
  let mergedContact = {};
  
  if(contact){
    mergedContact = {...contact?.toObject()};
  }

  if(chatLog?.otherMessages){
    Object.entries(chatLog?.otherMessages).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        if (value?.name !== undefined) {
          mergedContact[key] = value.name;
        } else if (value.value !== undefined) {
          mergedContact[key] = value.value;
        }
      }
    });
  }

  return replacePlaceholders(message, mergedContact);  
}

function replacePlaceholders(message, data) {
  return message.replace(/{(\w+)}/g, (_, key) => data[key] || `{${key}}`);
}

function formatForSummary(contact, event){
  // Initialize the final formatted data structure
  const formattedContact = {
    name: contact.name,
    number: contact.number,
  };

  // Map through the contact's `days` array and match with event details
  contact.days.forEach((day, index) => {
    
    const eventNameKey = `eventName${index + 1}`;
    const inviteAllocated = `allocated${index + 1}`;
    const acceptedKey = `accepted${index + 1}`;
    const rejectedKey = `rejected${index + 1}`;
    if (day.inviteStatus === 'Accepted') {
      formattedContact[eventNameKey] = event.subEventDetails[index].eventName;
      formattedContact[inviteAllocated] = day.invitesAllocated;
      formattedContact[acceptedKey] = day.invitesAccepted;
    } else if (day.inviteStatus === 'Rejected') {
      formattedContact[eventNameKey] = event.subEventDetails[index].eventName;
      formattedContact[inviteAllocated] = day.invitesAllocated;
      formattedContact[rejectedKey] = day.invitesAccepted;
    }
  });

  // Output the formatted data
  return formattedContact;
}

function removeEmptyLines(text) {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .join('\n\n');
}

function replaceConditionalPlaceholders(template, data) {

 template = template.replace(/{#if accepted(\d+)}([\s\S]*?){\/if}/g, (match, index, content) => {
  return data[`accepted${index}`] !== undefined ? content.replace(/{(\w+)}/g, (_, key) => data[key] || `{${key}}`) : '';
});

// Replace placeholders for rejected invitations
template = template.replace(/{#if rejected(\d+)}([\s\S]*?){\/if}/g, (match, index, content) => {
  return data[`rejected${index}`] !== undefined ? content.replace(/{(\w+)}/g, (_, key) => data[key] || `{${key}}`) : '';
});

return removeEmptyLines(template);
}


const getReport = async (req, res) => {
  const { fromDate, toDate } = req.query;
  const {id} = req.params;
  let startDate, endDate;

  if (fromDate && toDate) {
    startDate = new Date(fromDate);
    endDate = new Date(toDate);
  }

  const event = await Event.findOne({_id:id})
  const events = event.subEventDetails.map((ele)=>ele.eventName)

  const fileName = await getReportdataByTime(startDate,endDate, '', event?._id , events)
  const filename = fileName.split('/').pop();
  const fileUrl = process.env.IMAGE_URL+fileName;

  return res.status(200).send({
    fileUrl, filename
  });
};

async function getReportdataByTime(startDate, endDate, id, eventId, eventsName) {
  let dateFilter = {};
  if (startDate && endDate) {
    dateFilter = {
      "updatedAt": {
        $gte: new Date(startDate),
        $lt: new Date(endDate)
      }
    };
  }

  // console.log('instance', id)
  let query = [
    {
      $match: { eventId: eventId.toString(), }
    },
    {
      $lookup: {
        from: 'chatlogs',
        let: { contactNumber: '$number', eventId: '$eventId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$senderNumber', '$$contactNumber'] },
                  { $eq: ['$eventId', '$$eventId'] }
                ]
              }
            }
          },
          { $sort: { createdAt: -1 } }, // Sort by date in descending order
          { $limit: 1 } // Take only the latest chatlog
        ],
        as: 'chatlog'
      }
    },
    { $unwind: { path: '$chatlog', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        finalResponse: { $ifNull: ['$chatlog.finalResponse', ''] },
      }
    },
    {
      $project: {
        _id: 0,
        Name: '$name',
        PhoneNumber: { $toString: '$number' },
        days: '$days',
        overAllStatus: '$overAllStatus',
        UpdatedAt: { $ifNull: [{ $dateToString: { format: '%Y-%m-%d %H:%M:%S', date: '$updatedAt' } }, ''] }
      }
    }
  ];

  try {
    const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) {
        return ''; // Return blank if date is invalid
      }
      const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      };
      return new Date(date).toLocaleString('en-US', options).replace(',', '');
    };

    let data = await Contact.aggregate(query);

    data = data.map(ele => {
      let dayInfo = ele.days.map((day, index) => {
        if (day.invitesAllocated === 0) {
          return `not invited`;
        } else {
          return `${day.invitesAllocated}/${day.invitesAccepted}`;
        }
      });

      let status = "Not Invited"; // Default status
      ele.days.forEach(day => {
        if (day?.inviteStatus === "Accepted") {
          status = "Accepted";
        } else if (day?.inviteStatus === "Pending" && status !== "Accepted") {
          status = "Pending";
        } else if (day?.inviteStatus === "Rejected" && status !== "Accepted" && status !== "Pending") {
          status = "Rejected";
        }
      });

      return {
        Name: ele.Name,
        'Phone Number': ele.PhoneNumber,
        ...dayInfo.reduce((acc, val, idx) => ({ ...acc, [`${eventsName[idx]}`]: val }), {}),
        Status: status,
        'Updated At': formatDate(ele.UpdatedAt)
      };
    });


    const fileName = `Report-${Date.now()}.xlsx`;
    const filePath = `uploads/reports/${fileName}`;
    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Report');
    xlsx.writeFile(wb, filePath);

    console.log(`XLSX file created successfully at ${filePath}`);

    return filePath;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function getFullReport(startDate, endDate, id, eventId, rejectregex) {
  let dateFilter = {};
  if (startDate && endDate) {
    dateFilter = {
      "updatedAt": {
        $gte: new Date(startDate),
        $lt: new Date(endDate)
      }
    };
  }

  let query = [
    {
      $match: { eventId: eventId.toString(), }
    },
    {
      $lookup: {
        from: 'chatlogs',
        let: { contactNumber: '$number', eventId: '$eventId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$senderNumber', '$$contactNumber'] },
                  { $eq: ['$eventId', '$$eventId'] }
                ]
              }
            }
          },
          { $sort: { createdAt: -1 } }, // Sort by date in descending order
          { $limit: 1 } // Take only the latest chatlog
        ],
        as: 'chatlog'
      }
    },
    { $unwind: { path: '$chatlog', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        finalResponse: { $ifNull: ['$chatlog.finalResponse', ''] },
      }
    },
    {
      $project: {
        _id: 0,
        Name: '$name',
        PhoneNumber: { $toString: '$number' },
        days: '$days',
        overAllStatus: '$overAllStatus',
        UpdatedAt: { $ifNull: [{ $dateToString: { format: '%Y-%m-%d %H:%M:%S', date: '$updatedAt' } }, ''] }
      }
    }
  ];

  try {
    const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) {
        return ''; // Return blank if date is invalid
      }
      const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      };
      return new Date(date).toLocaleString('en-US', options).replace(',', '');
    };

    let data = await Contact.aggregate(query);

    data = data.map(ele => {
      let dayInfo = ele.days.map((day, index) => {
        if (day.invitesAllocated === 0) {
          return `not invited`;
        } else {
          return `${day.invitesAllocated}/${day.invitesAccepted}`;
        }
      });

      return {
        Name: ele.Name,
        'Phone Number': ele.PhoneNumber,
        ...dayInfo.reduce((acc, val, idx) => ({ ...acc, [`${eventsName[idx]}`]: val }), {}),
        Status: ele.overAllStatus,
        'Updated At': formatDate(ele.UpdatedAt)
      };
    });


    const fileName = `Report-${Date.now()}.xlsx`;
    const filePath = `uploads/reports/${fileName}`;
    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Report');
    xlsx.writeFile(wb, filePath);

    console.log(`XLSX file created successfully at ${filePath}`);

    return filePath;
  } catch (error) {
    console.error(error);
    return null;
  }
}


async function getDayStats(eventId) {
  try {
    // Step 1: Use MongoDB's aggregation framework to compute the statistics directly in the database
    const result = await Contact.aggregate([
      { $match: { eventId: eventId.toString() } }, // Match the contacts for the specific eventId

      // Step 2: Unwind the days array to compute stats for each day individually
      { $unwind: "$days" },

      // Step 3: Add a sequential index field to represent the day index
      {
        $group: {
          _id: {
            eventId: "$eventId",
            contactId: "$_id",
          },
          days: { $push: "$days" },
          overAllStatus: { $first: "$overAllStatus" }
        }
      },
      {
        $addFields: {
          dayIndexes: { $range: [0, { $size: "$days" }] }
        }
      },
      { $unwind: { path: "$days", includeArrayIndex: "dayIndex" } },

      // Step 4: Group by eventId and dayIndex to aggregate the stats
      {
        $group: {
          _id: {
            eventId: "$_id.eventId",
            dayIndex: "$dayIndex",
          },
          yesCount: {
            $sum: {
              $cond: [{ $eq: ["$days.inviteStatus", "Accepted"] }, 1, 0],
            },
          },
          noCount: {
            $sum: {
              $cond: [{ $eq: ["$days.inviteStatus", "Rejected"] }, 1, 0],
            },
          },
          pendingCount: {
            $sum: {
              $cond: [{ $eq: ["$days.inviteStatus", "Pending"] }, 1, 0],
            },
          },
          totalAccepted: {  
            $sum: {
              $cond: {
                if: { $isNumber: "$days.invitesAccepted" },
                then: "$days.invitesAccepted",
                else: { $toInt: "$days.invitesAccepted" },
              },
            },
          },
        },
      },

      // Step 5: Group the results by eventId to combine all day indices into one result
      {
        $group: {
          _id: "$_id.eventId",
          dayStats: {
            $push: {
              dayIndex: "$_id.dayIndex",
              yes: "$yesCount",
              no: "$noCount",
              pending: "$pendingCount",
              totalAccepted: "$totalAccepted",
            },
          },
        },
      },

      // Step 6: Merge the overall statistics
      // {
      //   $lookup: {
      //     from: "contacts",
      //     localField: "_id",
      //     foreignField: "eventId",
      //     as: "contacts",
      //   },
      // },
      // {
      //   $addFields: {
      //     totalContacts: { $size: "$contacts" },
      //     totalYesContacts: {
      //       $size: {
      //         $filter: {
      //           input: "$contacts",
      //           as: "contact",
      //           cond: { $eq: ["$$contact.overAllStatus", "Accepted"] },
      //         },
      //       },
      //     },
      //     totalNoContacts: {
      //       $size: {
      //         $filter: {
      //           input: "$contacts",
      //           as: "contact",
      //           cond: { $eq: ["$$contact.overAllStatus", "Rejected"] },
      //         },
      //       },
      //     },
      //     totalLeft: {
      //       $size: {
      //         $filter: {
      //           input: "$contacts",
      //           as: "contact",
      //           cond: {
      //             $and: [
      //               { $ne: ["$$contact.overAllStatus", "Accepted"] },
      //               { $ne: ["$$contact.overAllStatus", "Rejected"] },
      //             ],
      //           },
      //         },
      //       },
      //     },
      //   },
      // },

      // Step 7: Project the final output to match the desired format
      {
        $project: {
          _id: 0,
          // totalContacts: 1,
          // totalYesContacts: 1,
          // totalNoContacts: 1,
          // totalLeft: 1,
          dayStats: {
            $arrayToObject: {
              $map: {
                input: "$dayStats",
                as: "day",
                in: {
                  k: { $concat: ["Day_", { $toString: { $add: ["$$day.dayIndex", 1] } }] },
                  v: {
                    yes: "$$day.yes",
                    no: "$$day.no",
                    pending: "$$day.pending",
                    totalAccepted: "$$day.totalAccepted",
                  },
                },
              },
            },
          },
        },
      },
    ]);

    // If result is empty, return default values
    if (!result.length) {
      return {
        totalContacts: 0,
        totalYesContacts: 0,
        totalNoContacts: 0,
        totalLeft: 0,
        dayStats: {},
      };
    }

    // Return the computed statistics
    return result[0];
  } catch (error) {
    console.error("Error getting stats:", error);
    throw error; // Ensure errors are thrown to be handled by the calling function
  }
}


const fetchDashBoardStats = async(req, res)=>{
  const {eventId, instance_id} = req.body
  const instance = await Instance.findOne({_id:instance_id})
  const statsBody = await getDayStats(eventId, instance, '','')
  return res.send(statsBody)
}

const formatDate = (dateString) => {
  const date = new Date(dateString);
  const day = String(date.getDate()).padStart(2, '0'); // Add leading zero if needed
  const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are zero-based
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

module.exports = {
  saveContact,
  getContact,
  updateContacts,
  getMessages,
  sendMessages,
  recieveMessagesV2,
  getReport,
  saveContactsInBulk,
  sendBulkMessage,
  fetchDashBoardStats
};
